"""Pull durable ejabberd events and deliver eligible per-device APNs alerts."""
import logging
import signal
import threading
import time

import httpx

from .config import settings
from .ejabberd import EjabberdClient, EjabberdError
from .messaging_apns import APNSClient, APNSError
from .messaging_push import MAX_AGE, eligible_event, ingest_events, notification_payload
from .store import Store

log = logging.getLogger(__name__)


def dispatch_jobs(store, apns, now=None, limit=50):
    now = int(time.time()) if now is None else now
    with store._connect() as conn:
        jobs = conn.execute("""SELECT event_id FROM messaging_push_jobs
            WHERE status='pending' AND next_retry<=? ORDER BY created,event_id LIMIT ?""", (now, limit)).fetchall()
    for job in jobs:
        # Serialize eligibility and the bounded APNs call with device edits and
        # other workers. A committed lock/revoke prevents a subsequent send.
        with store._lock, store._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            event = conn.execute("SELECT * FROM messaging_push_jobs WHERE event_id=?", (job[0],)).fetchone()
            if not event or event["status"] != "pending" or event["next_retry"] > now:
                continue
            target = eligible_event(store, conn, event)
            if target is None or event["created"] + MAX_AGE <= now:
                conn.execute("UPDATE messaging_push_jobs SET status='discarded' WHERE event_id=?", (job[0],))
                continue
            try:
                apns.send(target, event, notification_payload(event))
            except APNSError as exc:
                if exc.status == 410 or (exc.status == 400 and exc.reason == "BadDeviceToken"):
                    conn.execute("DELETE FROM messaging_push_devices WHERE device_id=? AND node=?", (target["device_id"], target["node"]))
                    conn.execute("UPDATE messaging_push_jobs SET status='discarded',error=? WHERE event_id=?", (str(exc), job[0]))
                else:
                    attempts = event["attempts"] + 1
                    delay = max(exc.retry_after, min(300, 5 * 2 ** min(attempts - 1, 6)))
                    conn.execute("UPDATE messaging_push_jobs SET attempts=?,next_retry=?,error=? WHERE event_id=?",
                                 (attempts, now + delay, str(exc), job[0]))
                log.warning("Messaging notification delivery failed: HTTP %s (%s)", exc.status, exc.reason)
            except httpx.HTTPError as exc:
                attempts = event["attempts"] + 1
                conn.execute("UPDATE messaging_push_jobs SET attempts=?,next_retry=?,error=? WHERE event_id=?",
                    (attempts, now + min(300, 5 * 2 ** min(attempts - 1, 6)), type(exc).__name__, job[0]))
                log.warning("Messaging notification network failure: %s", type(exc).__name__)
            else:
                conn.execute("UPDATE messaging_push_jobs SET status='sent',error=NULL WHERE event_id=?", (job[0],))


def pull_events(store, ejabberd, host):
    events = ejabberd.push_events(host, 100)
    ingest_events(store, events)
    for event in events:
        ejabberd.acknowledge_push(host, event["id"])


def main():
    logging.basicConfig(level=logging.INFO)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    if not settings.messaging_push_enabled:
        log.info("Messaging notifications are disabled")
        stop.wait()
        return
    if (not settings.ejabberd_management_enabled or not settings.apns_team_id
            or not settings.apns_key_id or not settings.apns_bundle_id):
        raise SystemExit("Configure messaging management and the messaging APNs provider settings.")
    store = Store(settings.database_path)
    ejabberd = EjabberdClient(settings.ejabberd_api_url, settings.ejabberd_api_username, settings.ejabberd_api_password)
    try:
        apns = APNSClient(settings)
    except Exception:
        ejabberd.close()
        raise SystemExit("Could not load messaging APNs credentials; check the read-only key mount and provider settings.") from None
    try:
        while not stop.is_set():
            try:
                pull_events(store, ejabberd, settings.ejabberd_host)
            except EjabberdError as exc:
                log.warning("Messaging push synchronization failed: %s", exc)
            dispatch_jobs(store, apns)
            stop.wait(3)
    finally:
        ejabberd.close()
        apns.close()


if __name__ == "__main__":
    main()
