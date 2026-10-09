"""Device-authenticated room management; ejabberd owns authoritative membership."""
import re
from contextlib import contextmanager

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .ejabberd import EjabberdClient, EjabberdError
from .messaging_attachments import identity
from .messaging_identity import canonical_jid, identity_for_jid

ROOM_ID = re.compile(r"^vh-[a-f0-9]{32}$")


class RoomCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^vh-[a-f0-9]{32}$")
    name: str = Field(min_length=1, max_length=60)
    members: list[str] = Field(min_length=1, max_length=99)


class RoomChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(pattern=r"^(rename|add|remove|role|leave|close)$")
    revision: int = Field(ge=1)
    target: str = Field(default="", max_length=320)
    value: str = Field(default="", max_length=60)


def unavailable(status=404, message="This room is unavailable for your account."):
    return HTTPException(status_code=status, detail={"code": "room_unavailable", "message": message})


def room_node(jid, host):
    pieces = jid.split("@")
    if len(pieces) != 2 or pieces[1] != "rooms." + host or not ROOM_ID.fullmatch(pieces[0]):
        raise unavailable()
    return pieces[0]


def is_room(jid):
    return isinstance(jid, str) and "@rooms." in jid


@contextmanager
def room_client(settings):
    if not settings.ejabberd_management_enabled:
        raise unavailable(503, "Room management is not enabled.")
    client = EjabberdClient(settings.ejabberd_api_url, settings.ejabberd_api_username,
                            settings.ejabberd_api_password)
    try:
        yield client
    except EjabberdError:
        raise unavailable(503, "The room service is temporarily unavailable. Please refresh and retry.") from None
    finally:
        client.close()


def checked_rooms(client, owner):
    user, host = owner.split("@", 1)
    rows = client._request("voicehost_room_list", user=user, host=host)
    if not isinstance(rows, list) or len(rows) > 256:
        raise EjabberdError("Invalid room list")
    account = identity_for_jid(owner)[0]
    seen_rooms = set()
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {"jid", "name", "revision", "members"}
                or not isinstance(row["jid"], str) or row["jid"] in seen_rooms
                or not isinstance(row["name"], str) or not 1 <= len(row["name"]) <= 240
                or type(row["revision"]) is not int or row["revision"] < 1
                or not isinstance(row["members"], list) or not 1 <= len(row["members"]) <= 100):
            raise EjabberdError("Invalid room list")
        try:
            room_node(row["jid"], host)
        except HTTPException:
            raise EjabberdError("Invalid room service") from None
        seen_rooms.add(row["jid"])
        seen = set()
        for member in row["members"]:
            if (not isinstance(member, dict) or set(member) != {"jid", "name", "extension", "role"}
                    or not isinstance(member["jid"], str) or not isinstance(member["name"], str)
                    or not isinstance(member["extension"], str)
                    or not isinstance(member["role"], str) or member["role"] not in {"owner", "admin", "member"}):
                raise EjabberdError("Invalid room membership")
            try:
                if (canonical_jid(member["jid"]) != member["jid"]
                        or identity_for_jid(member["jid"])[0] != account
                        or member["jid"].split("@", 1)[1] != host
                        or identity_for_jid(member["jid"])[1] != member["extension"]
                        or member["jid"] in seen):
                    raise ValueError()
            except ValueError:
                raise EjabberdError("Invalid room membership") from None
            seen.add(member["jid"])
        if owner not in seen or not any(m["role"] == "owner" for m in row["members"]):
            raise EjabberdError("Invalid room membership")
    return rows


def check_room(settings, owner, jid):
    room_node(jid, owner.split("@", 1)[1])
    with room_client(settings) as client:
        row = next((r for r in checked_rooms(client, owner) if r["jid"] == jid), None)
        if row is None:
            raise unavailable()
        return row


class Rooms:
    def __init__(self, store, settings):
        self.store, self.settings = store, settings

    def actor(self, device):
        with self.store._connect() as conn:
            return identity(self.store, conn, device["id"], device["_access_token"])

    def list(self, device):
        owner = self.actor(device)
        with room_client(self.settings) as client:
            result = checked_rooms(client, owner)
        if self.actor(device) != owner:
            raise unavailable()
        return {"rooms": result}

    def mutate(self, device, command, **args):
        owner = self.actor(device)
        user, host = owner.split("@", 1)
        with self.store._lock, self.store._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            with room_client(self.settings) as client:
                # Re-check device identity immediately before issuing the command.
                # The remote registry also checks enabled membership and actor role.
                if identity(self.store, conn, device["id"], device["_access_token"]) != owner:
                    raise unavailable()
                result = client._request(command, user=user, host=host, **args)
                if type(result) is not int or result not in {0, 1, 2, 3}:
                    raise EjabberdError("Invalid room operation result")
                if result == 1:
                    raise unavailable(403, "You cannot make this room change. Owners must appoint another owner before leaving.")
                if result == 2:
                    raise unavailable(503, "The room change is being synchronized. Refresh shortly before retrying.")
                if result == 3:
                    raise unavailable(409, "The room has changed. Refresh its members before retrying.")
        return self.list(device)

    def create(self, device, request):
        owner = self.actor(device)
        host = owner.split("@", 1)[1]
        members = []
        for jid in request.members:
            try:
                if (canonical_jid(jid) != jid or identity_for_jid(jid)[0] != identity_for_jid(owner)[0]
                        or jid.split("@", 1)[1] != host):
                    raise ValueError()
            except ValueError:
                raise unavailable(400)
            members.append(jid.split("@", 1)[0])
        name = request.name.strip()
        if not name or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise unavailable(400)
        return self.mutate(device, "voicehost_room_create", room=request.id, name=name,
                           users=",".join(sorted(set(members))))

    def change(self, device, id, request):
        if not ROOM_ID.fullmatch(id):
            raise unavailable()
        target = request.target
        if target:
            owner = self.actor(device)
            try:
                if (canonical_jid(target) != target or identity_for_jid(target)[0] != identity_for_jid(owner)[0]
                        or target.split("@", 1)[1] != owner.split("@", 1)[1]):
                    raise ValueError()
            except ValueError:
                raise unavailable(400)
            target = target.split("@", 1)[0]
        return self.mutate(device, "voicehost_room_manage", room=id, action=request.action,
                           target=target, value=request.value.strip(), revision=request.revision)
