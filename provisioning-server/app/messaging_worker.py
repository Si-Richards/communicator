"""Reconcile shared accounts from committed device state, with durable retries."""
import logging
import json
import hashlib
import signal
import threading
from datetime import timedelta

from .config import settings
from .ejabberd import EjabberdClient, EjabberdError
from .store import Store, iso, parse_time, utcnow
from .messaging_identity import directory_address

log = logging.getLogger(__name__)


def reconcile_accounts(store, client):
    with store._connect() as conn:
        jids = [row[0] for row in conn.execute("SELECT jid FROM messaging_accounts ORDER BY jid")]
    for jid in jids:
        # One bounded API operation sequence per transaction serializes workers
        # and device mutations across the public/admin processes. A crash leaves
        # the old applied state intact; the next run inspects the remote account.
        with store._lock, store._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            account = conn.execute("SELECT * FROM messaging_accounts WHERE jid = ?", (jid,)).fetchone()
            enabled = bool(store.messaging_active_references(conn, jid))
            # One directory contact per shared identity. Choose the oldest active
            # device's managed display name deterministically; no handset names.
            display_name = account["extension"] or ""
            directory_extension = account["extension"] or ""
            for row in conn.execute("SELECT state,config_json FROM devices ORDER BY created_at,id"):
                config = json.loads(row["config_json"])
                messaging = config.get("messaging") or {}
                if (row["state"] == "active" and messaging.get("managed") and messaging.get("enabled")
                        and messaging.get("jid") == jid and config.get("features", {}).get("messaging") is not False):
                    display_name = str(config.get("device", {}).get("display_name") or display_name)[:120]
                    directory_extension = str(config.get("telephony", {}).get("extension") or directory_extension).strip().lower()
                    break
            signature = hashlib.sha256(json.dumps([account["account_number"], account["extension"],
                                                    directory_extension, display_name, enabled]).encode()).hexdigest()
            if (account["applied_enabled"] == enabled and account["status"] != "error"
                    and account["applied_directory_signature"] == signature
                    and account["directory_synced_at"]
                    and (utcnow() - parse_time(account["directory_synced_at"])).total_seconds() < 60):
                continue
            if (account["next_retry_at"] and account["attempted_enabled"] == enabled
                    and parse_time(account["next_retry_at"]) > utcnow()):
                continue
            try:
                if not account["account_number"] or not account["extension"]:
                    raise EjabberdError("Managed messaging requires an accountnumber*extension SIP username.")
                try:
                    directory_extension = directory_address(directory_extension)
                except ValueError as exc:
                    raise EjabberdError(str(exc)) from None
                if not enabled:
                    # Remove directory/policy access before a possibly failing
                    # ban call. An existing XMPP session must lose access too.
                    client.publish_identity(account, False, display_name, directory_extension)
                owned = client.reconcile(account, enabled)
                if enabled:
                    client.publish_identity(account, owned, display_name, directory_extension)
            except EjabberdError as exc:
                attempts = min(account["attempts"] + 1, 10)
                conn.execute("""UPDATE messaging_accounts
                    SET status='error', error=?, attempts=?, next_retry_at=?, attempted_enabled=? WHERE jid=?""",
                    (str(exc), attempts, iso(utcnow() + timedelta(seconds=min(300, 5 * 2 ** (attempts - 1)))), enabled, jid))
                # Deliberately omit exception traces and request/response payloads.
                log.warning("Messaging synchronization failed for %s: %s", jid, exc)
                ready = False
            else:
                conn.execute("""UPDATE messaging_accounts
                    SET owned=?, applied_enabled=?, attempted_enabled=?, status=?, error=NULL,
                        attempts=0, next_retry_at=NULL, applied_directory_signature=?, directory_synced_at=? WHERE jid=?""",
                    (owned, enabled, enabled, "enabled" if enabled else "disabled", signature, iso(utcnow()), jid))
                ready = enabled
                # Publish readiness as a normal versioned configuration change.
                # Phones wait for this rather than failing authentication while
                # the worker is still creating their account.
            for row in conn.execute("SELECT id, config_json, configuration_version FROM devices").fetchall():
                config = json.loads(row["config_json"])
                messaging = config.get("messaging") or {}
                if (messaging.get("managed") and messaging.get("jid") == jid
                        and messaging.get("ready") != ready):
                    config["messaging"]["ready"] = ready
                    config["version"] = row["configuration_version"] + 1
                    conn.execute("UPDATE devices SET config_json=?, configuration_version=?, updated_at=? WHERE id=?",
                        (json.dumps(config), config["version"], iso(utcnow()), row["id"]))


def main():
    logging.basicConfig(level=logging.INFO)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    store = Store(settings.database_path)
    if not settings.ejabberd_management_enabled:
        log.info("Automatic ejabberd management is disabled")
        stop.wait()
        return
    client = EjabberdClient(settings.ejabberd_api_url, settings.ejabberd_api_username, settings.ejabberd_api_password)
    try:
        while not stop.is_set():
            reconcile_accounts(store, client)
            stop.wait(5)
    finally:
        client.close()


if __name__ == "__main__":
    main()
