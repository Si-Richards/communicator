"""Device-bound registration and durable, tenant-checked notification jobs."""
import hashlib
import json
import secrets
import time

from .messaging_identity import canonical_jid, identity_for_jid
from .store import iso, utcnow

MAX_AGE = 900


def active_identity(store, conn, device_id):
    row = conn.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
    if row is None or row["state"] != "active" or row["platform"] != "ios":
        return None
    config = json.loads(row["config_json"])
    messaging = config.get("messaging") or {}
    jid = messaging.get("jid", "")
    if (not messaging.get("enabled") or not messaging.get("managed") or not messaging.get("ready")
            or config.get("features", {}).get("messaging") is False):
        return None
    try:
        if canonical_jid(jid) != jid:
            return None
    except ValueError:
        return None
    account = conn.execute("SELECT * FROM messaging_accounts WHERE jid=?", (jid,)).fetchone()
    if not account or not account["owned"] or account["status"] != "enabled" or account["applied_enabled"] != 1:
        return None
    return jid


def register_device(store, device_id, token, environment):
    with store._lock, store._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        jid = active_identity(store, conn, device_id)
        if jid is None:
            raise ValueError("Device is not eligible")
        previous = conn.execute("SELECT * FROM messaging_push_devices WHERE device_id=?", (device_id,)).fetchone()
        unchanged = previous and (previous["jid"], previous["token"], previous["environment"]) == (jid, token, environment)
        node = previous["node"] if unchanged else "vh-" + secrets.token_hex(32)
        # A re-enrolled installation can retain its APNs token. Transfer it,
        # invalidating old nodes rather than delivering across account changes.
        conn.execute("DELETE FROM messaging_push_devices WHERE token=? AND environment=? AND device_id!=?", (token, environment, device_id))
        conn.execute("""INSERT INTO messaging_push_devices VALUES (?,?,?,?,?,?)
            ON CONFLICT(device_id) DO UPDATE SET jid=excluded.jid,node=excluded.node,
            token=excluded.token,environment=excluded.environment,updated_at=excluded.updated_at""",
            (device_id, jid, node, token, environment, iso(utcnow())))
        return {"enabled": True, "owner_jid": jid, "jid": jid.split("@", 1)[1], "node": node}


def eligible_event(store, conn, event):
    target = conn.execute("SELECT * FROM messaging_push_devices WHERE node=?", (event["node"],)).fetchone()
    if not target or target["jid"] != event["jid"] or active_identity(store, conn, target["device_id"]) != target["jid"]:
        return None
    try:
        if canonical_jid(event["peer"]) != event["peer"]:
            return None
        if (identity_for_jid(event["peer"])[0] != identity_for_jid(event["jid"])[0]
                or event["peer"].split("@", 1)[1] != event["jid"].split("@", 1)[1]
                or event["peer"] == event["jid"]):
            return None
    except ValueError:
        return None
    peer = conn.execute("SELECT status,owned FROM messaging_accounts WHERE jid=?", (event["peer"],)).fetchone()
    if not peer or peer["status"] != "enabled" or not peer["owned"] or not store.messaging_active_references(conn, event["peer"]):
        return None
    return target


def ingest_events(store, events, now=None):
    now = int(time.time()) if now is None else now
    with store._lock, store._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        for event in events:
            if now - MAX_AGE <= event["created"] <= now + 60 and eligible_event(store, conn, event):
                conn.execute("""INSERT OR IGNORE INTO messaging_push_jobs
                    (event_id,node,jid,peer,created) VALUES (?,?,?,?,?)""",
                    (event["id"], event["node"], event["jid"], event["peer"], event["created"]))
        conn.execute("DELETE FROM messaging_push_jobs WHERE created<?", (now - 7 * 86400,))
    # The caller ACKs only after this transaction commits. Ineligible events
    # are discarded, never replayed on a later unlock or account reassignment.


def notification_payload(event):
    thread = hashlib.sha256((event["jid"] + "|" + event["peer"]).encode()).hexdigest()
    return {"aps": {"alert": {"title": "VoiceHost", "body": "New VoiceHost message"},
                    "sound": "default", "thread-id": thread},
            "type": "messaging", "owner_jid": event["jid"], "peer_jid": event["peer"],
            "event_id": event["event_id"]}
