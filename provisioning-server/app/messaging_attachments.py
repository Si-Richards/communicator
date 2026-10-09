"""Private, conversation-bound attachment storage. Never publish blob URLs."""
import hashlib
import json
import re
import secrets
import time
from pathlib import Path

from fastapi import HTTPException

from .messaging_identity import canonical_jid, identity_for_jid
from .store import hash_secret, parse_time, utcnow

MAX_BYTES = 10 * 1024 * 1024
ID = re.compile(r"^[a-f0-9]{64}$")


def denied(code="attachment_unavailable", status=404):
    return HTTPException(status_code=status, detail={
        "code": code, "message": {
            "attachment_too_large": "Attachments must be between 1 byte and 10 MB.",
            "attachment_quota": "Your account's attachment storage is full.",
            "attachment_length": "The attachment size could not be verified.",
        }.get(code, "This attachment or conversation is unavailable."),
    })


def filename(value):
    value = value.replace("\\", "/").split("/")[-1]
    value = "".join(c for c in value if c.isprintable() and c not in "/\\")
    return value.strip()[:160] or "attachment"


def media_type(header):
    # Never trust a supplied Content-Type or filename to render active content.
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


def identity(store, conn, device_id, token):
    credential = conn.execute(
        "SELECT * FROM access_tokens WHERE token_hash=?", (hash_secret(token),)
    ).fetchone()
    if (credential is None or credential["device_id"] != device_id
            or credential["revoked_at"] is not None
            or parse_time(credential["expires_at"]) <= utcnow()):
        raise denied("unauthorized", 401)
    device = conn.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
    if not device or device["state"] != "active":
        raise denied(status=403)
    config = json.loads(device["config_json"])
    messaging = config.get("messaging") or {}
    jid = messaging.get("jid", "")
    if (not messaging.get("enabled") or not messaging.get("managed")
            or not messaging.get("ready") or config.get("features", {}).get("messaging") is False):
        raise denied(status=403)
    try:
        if canonical_jid(jid) != jid:
            raise ValueError()
    except ValueError:
        raise denied(status=403)
    account = conn.execute("SELECT * FROM messaging_accounts WHERE jid=?", (jid,)).fetchone()
    if not account or not account["owned"] or account["status"] != "enabled" or account["applied_enabled"] != 1:
        raise denied(status=403)
    return jid


def check_peer(store, conn, owner, peer):
    try:
        if (canonical_jid(peer) != peer or peer == owner
                or identity_for_jid(owner)[0] != identity_for_jid(peer)[0]
                or owner.split("@")[1] != peer.split("@")[1]):
            raise ValueError()
    except ValueError:
        raise denied()
    row = conn.execute("SELECT * FROM messaging_accounts WHERE jid=?", (peer,)).fetchone()
    if (not row or not row["owned"] or row["status"] != "enabled" or row["applied_enabled"] != 1
            or not store.messaging_active_references(conn, peer)):
        raise denied()


def metadata(row):
    return {key: row[key] for key in ("id", "name", "media_type", "size", "sha256")}


class Attachments:
    def __init__(self, store, settings):
        self.store = store
        self.settings = settings
        self.root = Path(settings.messaging_attachment_directory)

    def path(self, id, partial=False):
        if not ID.fullmatch(id):
            raise denied()
        return self.root / (id + (".part" if partial else ".blob"))

    def purge(self, conn, now):
        for row in conn.execute("SELECT id FROM messaging_attachments WHERE expires<=?", (now,)).fetchall():
            self.path(row["id"]).unlink(missing_ok=True)
            self.path(row["id"], True).unlink(missing_ok=True)
        conn.execute("DELETE FROM messaging_attachments WHERE expires<=?", (now,))

    def reserve(self, device, peer, name, size):
        if size < 1 or size > MAX_BYTES:
            raise denied("attachment_too_large", 413)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        now = int(time.time())
        with self.store._lock, self.store._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            owner = identity(self.store, conn, device["id"], device["_access_token"])
            self.check_conversation(conn, owner, peer)
            self.purge(conn, now)
            account = identity_for_jid(owner)[0] + "@" + owner.split("@")[1]
            used = conn.execute("SELECT COALESCE(SUM(size),0) FROM messaging_attachments WHERE account=?", (account,)).fetchone()[0]
            if used + size > self.settings.messaging_attachment_quota_bytes:
                raise denied("attachment_quota", 413)
            id = secrets.token_hex(32)
            conn.execute("""INSERT INTO messaging_attachments
                (id,account,owner,peer,name,size,created,expires,status)
                VALUES (?,?,?,?,?,?,?,?, 'uploading')""",
                (id, account, owner, peer, filename(name), size, now, now + 120))
            return id

    def cleanup(self):
        with self.store._lock, self.store._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self.purge(conn, int(time.time()))

    def finish(self, id, device, peer, digest, header):
        with self.store._lock, self.store._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            owner = identity(self.store, conn, device["id"], device["_access_token"])
            self.check_conversation(conn, owner, peer)
            row = conn.execute("SELECT * FROM messaging_attachments WHERE id=?", (id,)).fetchone()
            if not row or row["owner"] != owner or row["peer"] != peer or row["status"] != "uploading":
                raise denied()
            self.path(id, True).replace(self.path(id))
            conn.execute("""UPDATE messaging_attachments SET sha256=?,media_type=?,
                expires=?,status='ready' WHERE id=?""",
                (digest, media_type(header), int(time.time()) + self.settings.messaging_attachment_retention_days * 86400, id))
            return metadata(conn.execute("SELECT * FROM messaging_attachments WHERE id=?", (id,)).fetchone())

    def discard(self, id):
        with self.store._lock, self.store._connect() as conn:
            conn.execute("DELETE FROM messaging_attachments WHERE id=?", (id,))
        self.path(id).unlink(missing_ok=True)
        self.path(id, True).unlink(missing_ok=True)

    def download(self, id, device, peer):
        path = self.path(id)
        with self.store._connect() as conn:
            actor = identity(self.store, conn, device["id"], device["_access_token"])
            row = conn.execute("SELECT * FROM messaging_attachments WHERE id=?", (id,)).fetchone()
            if (not row or row["status"] != "ready" or row["expires"] <= int(time.time())
                    or not path.is_file()):
                raise denied()
            from .messaging_rooms import is_room
            if is_room(row["peer"]):
                if peer != row["peer"]:
                    raise denied()
                self.check_conversation(conn, actor, peer)
            elif {row["owner"], row["peer"]} != {actor, peer}:
                raise denied()
            return path, dict(row)

    def check_conversation(self, conn, owner, peer):
        from .messaging_rooms import check_room, is_room
        if is_room(peer):
            check_room(self.settings, owner, peer)
        else:
            check_peer(self.store, conn, owner, peer)
