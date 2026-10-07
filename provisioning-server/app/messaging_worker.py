"""Reconcile shared accounts from committed device state, with durable retries."""
import logging
import json
import signal
import threading
from datetime import timedelta

from .config import settings
from .ejabberd import EjabberdClient, EjabberdError
from .store import Store, iso, parse_time, utcnow

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
            if account["applied_enabled"] == enabled and account["status"] != "error":
                continue
            if (account["next_retry_at"] and account["attempted_enabled"] == enabled
                    and parse_time(account["next_retry_at"]) > utcnow()):
                continue
            try:
                owned = client.reconcile(account, enabled)
            except EjabberdError as exc:
                attempts = min(account["attempts"] + 1, 10)
                conn.execute("""UPDATE messaging_accounts
                    SET status='error', error=?, attempts=?, next_retry_at=?, attempted_enabled=? WHERE jid=?""",
                    (str(exc), attempts, iso(utcnow() + timedelta(seconds=min(300, 5 * 2 ** (attempts - 1)))), enabled, jid))
                # Deliberately omit exception traces and request/response payloads.
                log.warning("Messaging synchronization failed for %s", jid)
            else:
                conn.execute("""UPDATE messaging_accounts
                    SET owned=?, applied_enabled=?, attempted_enabled=?, status=?, error=NULL,
                        attempts=0, next_retry_at=NULL WHERE jid=?""",
                    (owned, enabled, enabled, "enabled" if enabled else "disabled", jid))
                # Publish readiness as a normal versioned configuration change.
                # Phones wait for this rather than failing authentication while
                # the worker is still creating their account.
                for row in conn.execute("SELECT id, config_json, configuration_version FROM devices").fetchall():
                    config = json.loads(row["config_json"])
                    messaging = config.get("messaging") or {}
                    if (messaging.get("managed") and messaging.get("jid") == jid
                            and messaging.get("ready") != enabled):
                        config["messaging"]["ready"] = enabled
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
