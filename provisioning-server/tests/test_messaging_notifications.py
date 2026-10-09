"""Standard push registration, tenant boundaries and durable delivery."""
import json
import tempfile
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from test_ejabberd_lifecycle import FakeEjabberd
from app import main
from app.ejabberd import EjabberdClient, EjabberdError
from app.messaging_worker import reconcile_accounts
from app.messaging_push import register_device, ingest_events
from app.messaging_notifications import dispatch_jobs, pull_events
from app.messaging_apns import APNSClient, APNSError
from app.models import AdminActivationRequest
from app.store import Store

HOST = "ejabberd.voicehost.io"
TOKEN = "ab" * 32


class FakeAPNs:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def send(self, target, event, payload):
        self.calls.append((dict(target), dict(event), payload))
        if self.error:
            raise self.error


class NotificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(str(Path(self.tmp.name) / "push.db"))
        self.addCleanup(patch.stopall)
        patch.object(main, "store", self.store).start()
        patch.object(main, "settings", replace(main.settings, ejabberd_management_enabled=True,
                                                messaging_push_enabled=True)).start()
        self.ej = EjabberdClient("https://private.example/api/v2", "api@example", "secret",
                                httpx.MockTransport(FakeEjabberd().handle))
        self.addCleanup(self.ej.close)
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        self.n = 0
        self.owner, self.access = self.device("10000*213T")
        self.peer, _ = self.device("10000*230D")
        self.foreign, _ = self.device("20000*230")
        reconcile_accounts(self.store, self.ej)
        self.sub = register_device(self.store, self.owner, TOKEN, "sandbox")
        self.now = int(time.time())

    def device(self, username, platform="ios"):
        self.n += 1
        req = AdminActivationRequest(extension=username.split("*")[1].rstrip("TD"), sip_username=username,
                                     messaging_enabled=True, messaging_managed=True)
        _, code, _ = self.store.create_activation(req.model_dump(), 900)
        result, failure = self.store.activate_device(code, {"installation_id": str(self.n), "platform": platform,
            "device_type": "mobile", "app_version": "test", "app_build": 37}, main.build_configuration, None, 900)
        self.assertIsNone(failure)
        return result[0], result[1]

    def event(self, **overrides):
        return {"id": "c" * 64, "node": self.sub["node"], "jid": "10000*213@" + HOST,
                "peer": "10000*230@" + HOST, "created": self.now} | overrides

    def jobs(self):
        with self.store._connect() as conn:
            return [dict(r) for r in conn.execute("SELECT * FROM messaging_push_jobs")]

    def queue(self, **overrides):
        ingest_events(self.store, [self.event(**overrides)], self.now)

    def test_authenticated_registration_is_device_bound_and_no_store(self):
        url = "/api/v1/device/messaging/push"
        self.assertEqual(self.client.put(url, json={"token": TOKEN, "environment": "sandbox"}).status_code, 401)
        response = self.client.put(url, headers={"Authorization": "Bearer " + self.access},
                                   json={"token": TOKEN.upper(), "environment": "sandbox"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), self.sub)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn(TOKEN, response.text)
        # A caller cannot choose its JID or another installation.
        self.assertEqual(self.client.put(url, headers={"Authorization": "Bearer " + self.access},
            json={"token": TOKEN, "environment": "sandbox", "owner_jid": "20000*230@" + HOST}).status_code, 422)
        self.store.set_device_state(self.owner, "locked")
        self.assertEqual(self.client.put(url, headers={"Authorization": "Bearer " + self.access},
            json={"token": TOKEN, "environment": "sandbox"}).status_code, 423)
        self.assertEqual(self.client.delete(url, headers={"Authorization": "Bearer " + self.access}).status_code, 204)

    def test_registration_validation(self):
        for token, environment in [("not-hex", "sandbox"), ("a" * 33, "sandbox"), (TOKEN, "other"), ("a" * 514, "production")]:
            with self.subTest(token=token[:8], environment=environment):
                r = self.client.put("/api/v1/device/messaging/push", headers={"Authorization": "Bearer " + self.access},
                                    json={"token": token, "environment": environment})
                self.assertEqual(r.status_code, 422)
        android, _ = self.device("10000*231", "android")
        reconcile_accounts(self.store, self.ej)
        with self.assertRaises(ValueError):
            register_device(self.store, android, TOKEN, "sandbox")

    def test_repeated_registration_stable_but_token_rotation_invalidates_queued_node(self):
        self.assertEqual(register_device(self.store, self.owner, TOKEN, "sandbox"), self.sub)
        self.queue()
        new = register_device(self.store, self.owner, "cd" * 32, "sandbox")
        self.assertNotEqual(new["node"], self.sub["node"])
        apns = FakeAPNs()
        dispatch_jobs(self.store, apns, self.now)
        self.assertEqual(apns.calls, [])
        self.assertEqual(self.jobs()[0]["status"], "discarded")

    def test_lock_unlock_before_poll_cannot_reactivate_old_events(self):
        self.queue()
        old = self.sub["node"]
        self.store.set_device_state(self.owner, "locked")
        self.store.set_device_state(self.owner, "active")
        self.sub = register_device(self.store, self.owner, TOKEN, "sandbox")
        self.assertNotEqual(old, self.sub["node"])
        apns = FakeAPNs()
        dispatch_jobs(self.store, apns, self.now)
        self.assertEqual(apns.calls, [])
        self.assertEqual(self.jobs()[0]["status"], "discarded")

    def test_disable_reenable_before_poll_cannot_reactivate_old_events(self):
        self.queue()
        config = self.store.get_device(self.owner)["config"]
        old = self.sub["node"]
        config["features"]["messaging"] = False
        self.store.update_device_configuration(self.owner, config)
        config["features"]["messaging"] = True
        self.store.update_device_configuration(self.owner, config)
        self.sub = register_device(self.store, self.owner, TOKEN, "sandbox")
        self.assertNotEqual(old, self.sub["node"])
        apns = FakeAPNs()
        dispatch_jobs(self.store, apns, self.now)
        self.assertEqual(apns.calls, [])

    def test_token_transfer_prevents_old_account_delivery(self):
        self.queue()
        foreign = register_device(self.store, self.foreign, TOKEN, "sandbox")
        self.assertNotEqual(foreign["node"], self.sub["node"])
        apns = FakeAPNs()
        dispatch_jobs(self.store, apns, self.now)
        self.assertEqual(apns.calls, [])
        self.assertEqual(self.jobs()[0]["status"], "discarded")

    def test_two_devices_of_same_user_receive_distinct_jobs(self):
        other, _ = self.device("10000*213D")
        reconcile_accounts(self.store, self.ej)
        sub = register_device(self.store, other, "cd" * 32, "production")
        self.assertNotEqual(sub["node"], self.sub["node"])
        self.queue()
        self.queue(id="d" * 64, node=sub["node"])
        apns = FakeAPNs()
        dispatch_jobs(self.store, apns, self.now)
        self.assertEqual(len(apns.calls), 2)
        self.assertEqual({x[0]["device_id"] for x in apns.calls}, {self.owner, other})
        self.assertEqual({x[2]["owner_jid"] for x in apns.calls}, {"10000*213@" + HOST})
        self.assertEqual({x[2]["aps"]["alert"]["body"] for x in apns.calls}, {"New VoiceHost message"})
        self.assertNotIn("badge", apns.calls[0][2]["aps"])

    def test_foreign_peer_owner_host_self_and_stale_events_discarded(self):
        cases = [{"jid": "20000*230@" + HOST}, {"peer": "20000*230@" + HOST},
                 {"peer": "10000*230@foreign.example"}, {"peer": "10000*213@" + HOST},
                 {"peer": "10000*230t@" + HOST}, {"created": self.now - 901}, {"created": self.now + 61},
                 {"node": "vh-" + "d" * 64}]
        for case in cases:
            self.queue(**case)
        self.assertEqual(self.jobs(), [])

    def test_lock_revocation_logout_and_feature_changes_checked_at_send(self):
        for mutation in ("locked", "revoked", "logged_out", "feature", "jid", "ready", "managed"):
            with self.subTest(mutation=mutation):
                with self.store._connect() as conn:
                    original = conn.execute("SELECT config_json FROM devices WHERE id=?", (self.owner,)).fetchone()[0]
                    conn.execute("DELETE FROM messaging_push_jobs")
                self.queue()
                if mutation in ("locked", "revoked", "logged_out"):
                    with self.store._connect() as conn:
                        conn.execute("UPDATE devices SET state=? WHERE id=?", (mutation, self.owner))
                else:
                    config = json.loads(original)
                    if mutation == "feature":
                        config["features"]["messaging"] = False
                    elif mutation == "jid":
                        config["messaging"]["jid"] = "20000*230@" + HOST
                    else:
                        config["messaging"][mutation] = False
                    with self.store._connect() as conn:
                        conn.execute("UPDATE devices SET config_json=? WHERE id=?", (json.dumps(config), self.owner))
                apns = FakeAPNs()
                dispatch_jobs(self.store, apns, self.now)
                self.assertEqual(apns.calls, [])
                self.assertEqual(self.jobs()[0]["status"], "discarded")
                with self.store._connect() as conn:
                    conn.execute("UPDATE devices SET state='active',config_json=? WHERE id=?", (original, self.owner))

    def test_dedup_and_restart_persist_jobs(self):
        self.queue()
        self.queue()
        reopened = Store(self.store.path)
        self.assertEqual(len(self.jobs()), 1)
        apns = FakeAPNs()
        dispatch_jobs(reopened, apns, self.now)
        self.queue()
        dispatch_jobs(self.store, apns, self.now)
        self.assertEqual(len(apns.calls), 1)
        self.assertEqual(self.jobs()[0]["status"], "sent")

    def test_ack_happens_after_persistence_and_lost_ack_replay_is_safe(self):
        outer = self
        class Pull:
            fail = True
            def push_events(self, host, limit):
                return [outer.event()]
            def acknowledge_push(self, host, event_id):
                outer.assertEqual(len(outer.jobs()), 1)
                if self.fail:
                    raise EjabberdError("lost ack")
        pull = Pull()
        with self.assertRaises(EjabberdError):
            pull_events(self.store, pull, HOST)
        pull.fail = False
        pull_events(self.store, pull, HOST)
        self.assertEqual(len(self.jobs()), 1)

    def test_concurrent_workers_do_not_send_one_committed_job_twice(self):
        from concurrent.futures import ThreadPoolExecutor
        self.queue()
        apns = FakeAPNs()
        second = Store(self.store.path)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(dispatch_jobs, store, apns, self.now) for store in (self.store, second)]
            for future in futures:
                future.result(timeout=5)
        self.assertEqual(len(apns.calls), 1)

    def test_failure_to_commit_does_not_ack_remote_event(self):
        class Pull:
            def push_events(inner, host, limit):
                return [self.event()]
            def acknowledge_push(inner, host, event_id):
                self.fail("ACK before successful persistence")
        with patch("app.messaging_notifications.ingest_events", side_effect=RuntimeError("disk failure")):
            with self.assertRaises(RuntimeError):
                pull_events(self.store, Pull(), HOST)

    def test_disabled_server_and_not_ready_device_do_not_register(self):
        url = "/api/v1/device/messaging/push"
        with patch.object(main, "settings", replace(main.settings, messaging_push_enabled=False)):
            response = self.client.put(url, headers={"Authorization": "Bearer " + self.access},
                                       json={"token": TOKEN, "environment": "sandbox"})
        self.assertEqual(response.json(), {"enabled": False})
        pending, access = self.device("10000*231")
        response = self.client.put(url, headers={"Authorization": "Bearer " + access},
                                  json={"token": "cd" * 32, "environment": "sandbox"})
        self.assertEqual(response.status_code, 409)

    def test_apple_invalid_token_removes_registration(self):
        self.queue()
        with self.assertLogs("app.messaging_notifications", "WARNING") as logs:
            dispatch_jobs(self.store, FakeAPNs(APNSError(410, "Unregistered")), self.now)
        self.assertNotIn(TOKEN, str(logs.output))
        self.assertEqual(self.jobs()[0]["status"], "discarded")
        with self.store._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM messaging_push_devices").fetchone()[0], 0)

    def test_transient_retries_and_expiry(self):
        self.queue()
        apns = FakeAPNs(APNSError(503, "ServiceUnavailable", 20))
        with self.assertLogs("app.messaging_notifications", "WARNING"):
            dispatch_jobs(self.store, apns, self.now)
        self.assertEqual(self.jobs()[0]["next_retry"], self.now + 20)
        dispatch_jobs(self.store, apns, self.now + 19)
        self.assertEqual(len(apns.calls), 1)
        apns.error = None
        dispatch_jobs(self.store, apns, self.now + 20)
        self.assertEqual(self.jobs()[0]["status"], "sent")
        self.queue(id="e" * 64)
        dispatch_jobs(self.store, apns, self.now + 900)
        self.assertEqual([j["status"] for j in self.jobs()], ["sent", "discarded"])

    def test_network_failure_is_sanitized_and_retried(self):
        self.queue()
        with self.assertLogs("app.messaging_notifications", "WARNING") as logs:
            dispatch_jobs(self.store, FakeAPNs(httpx.ReadTimeout("sensitive-token")), self.now)
        self.assertEqual(self.jobs()[0]["error"], "ReadTimeout")
        self.assertNotIn("sensitive-token", str(logs.output))
        self.assertEqual(self.jobs()[0]["next_retry"], self.now + 5)


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.key = ec.generate_private_key(ec.SECP256R1())
        path = Path(self.tmp.name) / "test.p8"
        path.write_bytes(self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                serialization.NoEncryption()))
        self.settings = replace(main.settings, apns_key_path=str(path), apns_team_id="TEAM123456",
                                apns_key_id="KEY1234567", apns_bundle_id="io.voicehost.softphone")
        self.requests = []
        self.response = httpx.Response(200)
        def handle(request):
            self.requests.append(request)
            return self.response
        self.apns = APNSClient(self.settings, httpx.MockTransport(handle))
        self.addCleanup(self.apns.close)
        self.event = {"event_id": "c" * 64, "jid": "10000*213@" + HOST, "peer": "10000*230@" + HOST,
                      "created": int(time.time())}

    def send(self, env="sandbox"):
        self.apns.send({"token": TOKEN, "environment": env}, self.event, {"aps": {"alert": "New message"}})

    def test_standard_alert_headers_es256_identity_and_environment(self):
        for env, host in [("sandbox", "api.sandbox.push.apple.com"), ("production", "api.push.apple.com")]:
            self.send(env)
            request = self.requests[-1]
            self.assertEqual(request.url.host, host)
            self.assertEqual(request.headers["apns-topic"], self.settings.apns_bundle_id)
            self.assertEqual(request.headers["apns-push-type"], "alert")
            self.assertEqual(request.headers["apns-priority"], "10")
            self.assertEqual(request.headers["apns-expiration"], str(self.event["created"] + 900))
            token = request.headers["authorization"].split(" ", 1)[1]
            claims = jwt.decode(token, self.key.public_key(), algorithms=["ES256"])
            self.assertEqual(claims["iss"], self.settings.apns_team_id)
            self.assertEqual(jwt.get_unverified_header(token)["kid"], self.settings.apns_key_id)
        self.assertEqual(self.requests[0].headers["apns-id"], self.requests[1].headers["apns-id"])
        self.assertEqual(self.requests[0].headers["apns-collapse-id"], self.requests[1].headers["apns-collapse-id"])

    def test_rejection_sanitizes_raw_content_and_retry_hint(self):
        self.response = httpx.Response(429, json={"reason": "TooManyRequests"}, headers={"retry-after": "30"})
        with self.assertRaises(APNSError) as caught:
            self.send()
        self.assertEqual(caught.exception.retry_after, 30)
        self.assertEqual(caught.exception.reason, "TooManyRequests")
        for body in ({"reason": [TOKEN]}, {"reason": TOKEN}, [TOKEN]):
            self.response = httpx.Response(500, json=body)
            with self.assertRaises(APNSError) as caught:
                self.send()
            self.assertEqual(caught.exception.reason, "Rejected")
            self.assertNotIn(TOKEN, str(caught.exception))

    def test_expired_provider_token_refreshes_on_next_retry(self):
        original = self.apns._jwt_token
        self.response = httpx.Response(403, json={"reason": "ExpiredProviderToken"})
        with self.assertRaises(APNSError):
            self.send()
        self.assertIsNone(self.apns._jwt_token)
        self.response = httpx.Response(200)
        with patch("app.messaging_apns.time.time", return_value=time.time() + 2):
            self.send()
        self.assertNotEqual(original, self.apns._jwt_token)

    def test_http_info_logging_does_not_expose_token(self):
        import logging
        self.assertGreaterEqual(logging.getLogger("httpx").level, logging.WARNING)

    def test_invalid_credentials_fail_before_network(self):
        Path(self.settings.apns_key_path).write_text("invalid-private-key")
        with self.assertRaises(Exception):
            APNSClient(self.settings, httpx.MockTransport(lambda _: self.fail("network called")))

    def test_ejabberd_event_response_requires_metadata_contract(self):
        event = {"id": "c" * 64, "node": "vh-" + "d" * 64, "jid": "10000*213@" + HOST,
                 "peer": "10000*230@" + HOST, "created": 123}
        for result, valid in [([event], True), ([event | {"body": "private"}], False),
                               ([event | {"created": True}], False), ([event | {"id": "invalid"}], False), ({}, False)]:
            client = EjabberdClient("https://private.example/api/v2", "u", "p",
                                    httpx.MockTransport(lambda _, result=result: httpx.Response(200, json=result)))
            try:
                if valid:
                    self.assertEqual(client.push_events(HOST), result)
                else:
                    with self.assertRaises(EjabberdError):
                        client.push_events(HOST)
            finally:
                client.close()
