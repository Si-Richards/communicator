import json
import os
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from pydantic import ValidationError

_database = tempfile.TemporaryDirectory()
os.environ.setdefault("PROVISIONING_DATABASE", str(Path(_database.name) / "routes.db"))
from app import main
from app.ejabberd import EjabberdClient, EjabberdError
from app.messaging_worker import reconcile_accounts
from app.models import AdminActivationRequest, AdminDeviceConfigurationRequest, LogoutRequest
from app.store import Store


class FakeEjabberd:
    def __init__(self):
        self.users = {}
        self.bans = {}
        self.calls = []
        self.fail = None
        self.lose = None
        self.ban_details_as_object = False

    def handle(self, request):
        command = request.url.path.split("/")[-1]
        body = json.loads(request.content)
        jid = body["user"] + "@" + body["host"]
        self.calls.append((command, jid))
        if self.fail == command:
            return httpx.Response(403, json={"message": "remote-sensitive-content"})
        if command == "check_account":
            result = 0 if jid in self.users else 1
        elif command == "check_password":
            result = 0 if self.users.get(jid) == body["password"] else 1
        elif command == "register":
            if jid in self.users:
                return httpx.Response(409, json={"message": "conflict"})
            self.users[jid] = body["password"]
            result = "Success"
        elif command == "get_ban_details":
            if self.ban_details_as_object:
                result = {"reason": self.bans[jid]} if jid in self.bans else {}
            else:
                result = [{"name": "reason", "value": self.bans[jid]}] if jid in self.bans else []
        elif command == "ban_account":
            self.bans[jid] = body["reason"]
            result = 0
        elif command == "unban_account":
            self.bans.pop(jid, None)
            result = 0
        else:
            raise AssertionError("Unexpected API command")
        if self.lose == command:
            self.lose = None
            raise httpx.ReadTimeout("remote-sensitive-content", request=request)
        return httpx.Response(200, json=result)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(str(Path(self.tmp.name) / "accounts.db"))
        self.addCleanup(patch.stopall)
        patch.object(main, "store", self.store).start()
        patch.object(main, "settings", replace(main.settings, ejabberd_management_enabled=True)).start()
        self.fake = FakeEjabberd()
        self.api = EjabberdClient("https://private.example/api/v2", "provisioner@example", "api-secret",
                                  httpx.MockTransport(self.fake.handle))
        self.addCleanup(self.api.close)
        self.n = 0

    def create(self, username="10000*207"):
        self.n += 1
        request = AdminActivationRequest(extension="207", sip_username=username,
                                        messaging_enabled=True, messaging_managed=True)
        _, code, _ = self.store.create_activation(request.model_dump(), 900)
        result, failure = self.store.activate_device(code, {
            "installation_id": "installation-" + str(self.n), "platform": "ios",
            "device_type": "mobile", "app_version": "test", "app_build": 37,
        }, main.build_configuration, None, 900)
        self.assertIsNone(failure)
        return self.store.get_device(result[0])

    def sync(self):
        reconcile_accounts(self.store, self.api)

    def retry(self):
        with self.store._connect() as conn:
            conn.execute("UPDATE messaging_accounts SET next_retry_at=NULL")
        self.sync()

    def test_account_created_on_enrolment_with_dedicated_password_and_readiness(self):
        request = AdminActivationRequest(extension="207", sip_username="10000*207",
            sip_password="sip-secret", messaging_enabled=True, messaging_managed=True)
        self.store.create_activation(request.model_dump(), 900)
        self.sync()
        self.assertEqual(self.fake.users, {})  # Issuing a code creates no account.
        device = self.create()
        messaging = device["config"]["messaging"]
        self.assertEqual(messaging["jid"], "10000*207@ejabberd.voicehost.io")
        self.assertFalse(messaging["ready"])
        self.assertGreaterEqual(len(messaging["password"]), 48)
        self.assertNotEqual(messaging["password"], "sip-secret")
        self.sync()
        updated = self.store.get_device(device["id"])
        self.assertTrue(updated["config"]["messaging"]["ready"])
        self.assertEqual(updated["configuration_version"], 2)
        self.assertEqual(self.fake.users[messaging["jid"]], messaging["password"])
        self.sync()
        self.assertEqual(sum(cmd == "register" for cmd, _ in self.fake.calls), 1)

    def test_shared_account_locks_only_when_last_active_phone_is_disabled(self):
        first, second = self.create(), self.create()
        self.assertEqual(first["config"]["messaging"]["password"], second["config"]["messaging"]["password"])
        jid = first["config"]["messaging"]["jid"]
        self.sync()
        self.store.set_device_state(first["id"], "locked")
        self.sync()
        self.assertNotIn(jid, self.fake.bans)
        self.store.set_device_state(second["id"], "locked")
        self.sync()
        self.assertIn(jid, self.fake.bans)
        password = self.fake.users[jid]
        self.store.set_device_state(first["id"], "active")
        self.sync()
        self.assertNotIn(jid, self.fake.bans)
        self.assertEqual(self.fake.users[jid], password)

    def test_disable_revocation_retirement_and_logout_have_same_account_effect(self):
        for mode in ["disabled", "revoked", "retired", "logout"]:
            with self.subTest(mode=mode):
                device = self.create("tenant*" + mode)
                jid = device["config"]["messaging"]["jid"]
                self.sync()
                if mode == "disabled":
                    updated = main.update_managed_configuration(device["id"], AdminDeviceConfigurationRequest(
                        extension="207", messaging_enabled=False))
                    self.assertNotIn("password", updated["config"]["messaging"])
                    self.assertEqual(updated["config"]["messaging"]["jid"], jid)
                elif mode == "logout":
                    main.logout(LogoutRequest(), device)
                else:
                    self.store.set_device_state(device["id"], mode)
                self.sync()
                self.assertIn(jid, self.fake.bans)
                self.assertIn(jid, self.fake.users)  # Never delete accounts or archives.

    def test_identity_change_moves_one_phone_and_reuses_existing_account_on_return(self):
        device = self.create()
        old = device["config"]["messaging"]
        self.sync()
        updated = main.update_managed_configuration(device["id"], AdminDeviceConfigurationRequest(
            extension="208", sip_username="10000*208"))
        new = updated["config"]["messaging"]
        self.assertNotEqual(old["password"], new["password"])
        self.sync()
        self.assertIn(old["jid"], self.fake.bans)
        self.assertNotIn(new["jid"], self.fake.bans)
        restored = main.update_managed_configuration(device["id"], AdminDeviceConfigurationRequest(
            extension="207", sip_username="10000*207"))
        self.assertEqual(restored["config"]["messaging"]["password"], old["password"])
        self.sync()
        self.assertNotIn(old["jid"], self.fake.bans)
        self.assertIn(new["jid"], self.fake.bans)

    def test_lost_register_response_is_recovered_without_duplicate_or_secret_rotation(self):
        device = self.create()
        jid = device["config"]["messaging"]["jid"]
        self.fake.lose = "register"
        self.sync()
        self.assertEqual(self.store.messaging_account_status(jid)["status"], "error")
        self.assertNotIn("remote-sensitive-content", self.store.messaging_account_status(jid)["error"])
        self.retry()
        self.assertEqual(self.store.messaging_account_status(jid)["status"], "enabled")
        self.assertEqual(sum(cmd == "register" for cmd, _ in self.fake.calls), 1)

    def test_object_ban_details_recovers_creation_and_preserves_ban_ownership(self):
        self.fake.ban_details_as_object = True
        device = self.create()
        jid = device["config"]["messaging"]["jid"]
        password = device["config"]["messaging"]["password"]
        self.fake.lose = "register"
        self.sync()
        self.retry()
        self.assertEqual(self.store.messaging_account_status(jid)["status"], "enabled")
        self.assertTrue(self.store.get_device(device["id"])["config"]["messaging"]["ready"])
        self.assertEqual(sum(cmd == "register" for cmd, _ in self.fake.calls), 1)
        self.store.set_device_state(device["id"], "locked")
        self.sync()
        self.assertIn(jid, self.fake.bans)
        self.store.set_device_state(device["id"], "active")
        self.sync()
        self.assertNotIn(jid, self.fake.bans)
        self.assertEqual(self.fake.users[jid], password)
        self.store.set_device_state(device["id"], "locked")
        self.sync()
        self.fake.bans[jid] = "Independent administrator ban"
        self.store.set_device_state(device["id"], "active")
        self.sync()
        self.assertEqual(self.store.messaging_account_status(jid)["status"], "error")
        self.assertEqual(self.fake.bans[jid], "Independent administrator ban")

    def test_lost_register_then_immediate_lock_still_disables_remote_account(self):
        device = self.create()
        jid = device["config"]["messaging"]["jid"]
        self.fake.lose = "register"
        self.sync()
        self.store.set_device_state(device["id"], "locked")
        self.sync()  # Target changed: do not wait for the creation retry backoff.
        self.assertIn(jid, self.fake.bans)

    def test_lost_ban_and_unban_responses_are_retryable(self):
        device = self.create()
        jid = device["config"]["messaging"]["jid"]
        self.sync()
        self.store.set_device_state(device["id"], "locked")
        self.fake.lose = "ban_account"
        self.sync()
        self.retry()
        self.assertEqual(self.store.messaging_account_status(jid)["status"], "disabled")
        self.store.set_device_state(device["id"], "active")
        self.fake.lose = "unban_account"
        self.sync()
        self.retry()
        self.assertEqual(self.store.messaging_account_status(jid)["status"], "enabled")

    def test_preexisting_unmanaged_account_is_never_overwritten_or_banned(self):
        device = self.create()
        jid = device["config"]["messaging"]["jid"]
        self.fake.users[jid] = "outside-password"
        self.sync()
        self.assertEqual(self.store.messaging_account_status(jid)["status"], "error")
        self.store.set_device_state(device["id"], "locked")
        self.sync()
        self.assertEqual(self.fake.users[jid], "outside-password")
        self.assertNotIn(jid, self.fake.bans)
        self.assertFalse(any(cmd in {"register", "ban_account", "unban_account"} for cmd, _ in self.fake.calls))

    def test_external_ban_is_not_removed(self):
        device = self.create()
        jid = device["config"]["messaging"]["jid"]
        self.sync()
        self.store.set_device_state(device["id"], "locked")
        self.sync()
        self.fake.bans[jid] = "Independent administrator ban"
        self.store.set_device_state(device["id"], "active")
        self.sync()
        self.assertEqual(self.store.messaging_account_status(jid)["status"], "error")
        self.assertEqual(self.fake.bans[jid], "Independent administrator ban")

    def test_api_failure_leaves_pending_and_retries_after_store_reopen(self):
        device = self.create()
        jid = device["config"]["messaging"]["jid"]
        self.fake.fail = "register"
        self.sync()
        self.store = Store(self.store.path)
        self.fake.fail = None
        self.retry()
        self.assertEqual(self.store.messaging_account_status(jid)["status"], "enabled")

    def test_separate_workers_serialize_without_duplicate_creation(self):
        self.create()
        stores = [Store(self.store.path), Store(self.store.path)]
        errors = []
        def run(store):
            try:
                reconcile_accounts(store, self.api)
            except Exception as exc:
                errors.append(exc)
        threads = [threading.Thread(target=run, args=(store,)) for store in stores]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(sum(cmd == "register" for cmd, _ in self.fake.calls), 1)

    def test_public_checkin_delivers_readiness_without_disrupting_device_credentials(self):
        source = AdminActivationRequest(extension="207", sip_username="10000*207",
            messaging_enabled=True, messaging_managed=True).model_dump()
        _, code, _ = self.store.create_activation(source, 900)
        with TestClient(main.app) as client:
            response = client.post("/api/v1/device/activate", json={"code": code, "device": {
                "installation_id": "route-installation", "platform": "ios",
                "device_type": "mobile", "app_version": "test", "app_build": 37}})
            self.assertEqual(response.status_code, 201)
            activation = response.json()
            self.assertFalse(activation["configuration"]["messaging"]["ready"])
            headers = {"Authorization": "Bearer " + activation["access_token"]}
            self.sync()
            checkin = client.post("/api/v1/device/check-in", headers=headers, json={
                "configuration_version": 1, "app_version": "test", "app_build": 37})
            self.assertTrue(checkin.json()["configuration_changed"])
            downloaded = client.get("/api/v1/device/configuration", headers=headers)
            self.assertEqual(downloaded.status_code, 200)
            self.assertTrue(downloaded.json()["messaging"]["ready"])
            self.assertEqual(downloaded.json()["messaging"]["password"], activation["configuration"]["messaging"]["password"])
            self.assertEqual(downloaded.headers["cache-control"], "no-store")

    def test_manual_identity_cannot_be_adopted_and_failed_activation_preserves_code(self):
        manual = main.build_configuration({"extension": "207", "messaging_enabled": True,
            "messaging_jid": "10000*207@ejabberd.voicehost.io", "messaging_password": "manual-secret"})
        self.store.create_device({"installation_id": "manual", "platform": "ios",
            "device_type": "mobile", "app_version": "test", "app_build": 37}, manual, None)
        source = AdminActivationRequest(extension="207", sip_username="10000*207",
            messaging_enabled=True, messaging_managed=True).model_dump()
        _, code, _ = self.store.create_activation(source, 900)
        descriptor = {"installation_id": "automatic", "platform": "ios",
            "device_type": "mobile", "app_version": "test", "app_build": 37}
        with self.assertRaises(ValueError):
            self.store.activate_device(code, descriptor, main.build_configuration, None, 900)
        self.assertIsNotNone(self.store.consume_activation(code))
        with self.store._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM messaging_accounts").fetchone()[0], 0)

    def test_account_stays_active_when_another_device_moves_to_new_identity(self):
        first = self.create()
        self.create()
        jid = first["config"]["messaging"]["jid"]
        self.sync()
        main.update_managed_configuration(first["id"], AdminDeviceConfigurationRequest(
            extension="208", sip_username="10000*208"))
        self.sync()
        self.assertNotIn(jid, self.fake.bans)
        self.assertEqual(self.store.messaging_account_status(jid)["active_devices"], 1)

    def test_revoked_identity_can_only_return_via_a_new_activation(self):
        device = self.create()
        self.sync()
        self.store.set_device_state(device["id"], "revoked")
        self.sync()
        self.assertFalse(self.store.set_device_state(device["id"], "active"))
        replacement = self.create()
        self.assertEqual(device["config"]["messaging"]["password"], replacement["config"]["messaging"]["password"])
        self.sync()
        self.assertNotIn(device["config"]["messaging"]["jid"], self.fake.bans)

    def test_manual_configuration_conflicts_and_bad_identity_are_rejected(self):
        for username in [None, "user@domain", "user/resource", "user name"]:
            with self.assertRaises(ValidationError):
                AdminActivationRequest(extension="207", sip_username=username,
                    messaging_enabled=True, messaging_managed=True)
        device = self.create()
        jid = device["config"]["messaging"]["jid"]
        with self.assertRaises(Exception) as caught:
            main.update_managed_configuration(device["id"], AdminDeviceConfigurationRequest(
                extension="207", messaging_managed=False, messaging_jid=jid, messaging_password="manual"))
        self.assertEqual(caught.exception.status_code, 409)

    def test_configuration_and_portal_readiness_do_not_expose_registry(self):
        device = self.create()
        body = main.configuration(device)
        self.assertIn("password", body["messaging"])
        self.assertFalse(body["messaging"]["ready"])
        self.assertNotIn("messaging_accounts", body)
        status = self.store.messaging_account_status(body["messaging"]["jid"])
        self.assertNotIn("password", status)
        self.assertEqual(status["active_devices"], 1)

    def test_api_rejects_insecure_urls_and_unexpected_success_bodies(self):
        for url in ["http://server/api/v2", "https://server/api", "https://user:pass@server/api/v2"]:
            with self.assertRaises(ValueError):
                EjabberdClient(url, "api", "secret")
        api = EjabberdClient("https://server/api/v2", "api", "secret",
            httpx.MockTransport(lambda request: httpx.Response(200, json={"status": "error"})))
        self.addCleanup(api.close)
        # A successful HTTP status is insufficient to claim command success.
        with self.assertRaises(EjabberdError):
            api.call("register", user="bob", host="server", password="secret")

    def test_error_and_malformed_ban_objects_are_not_accepted_as_unbanned(self):
        for body in [{"status": "error"}, {"reason": None}, {"reason": False}, {"ban_details": {}}]:
            with self.subTest(body=body):
                api = EjabberdClient("https://server/api/v2", "api", "secret",
                    httpx.MockTransport(lambda request: httpx.Response(200, json=body)))
                self.addCleanup(api.close)
                with self.assertRaises(EjabberdError):
                    api.call("get_ban_details", user="bob", host="server")

    def test_worker_error_logs_show_http_status_without_remote_payloads_or_secrets(self):
        device = self.create()
        self.fake.fail = "get_ban_details"
        with self.assertLogs("app.messaging_worker", level="WARNING") as logs:
            self.sync()
        jid = device["config"]["messaging"]["jid"]
        error = self.store.messaging_account_status(jid)["error"]
        self.assertIn("get_ban_details failed (HTTP 403)", error)
        self.assertIn(error, logs.output[0])
        self.assertNotIn("remote-sensitive-content", error + logs.output[0])
        self.assertNotIn(device["config"]["messaging"]["password"], error + logs.output[0])
        self.assertNotIn("api-secret", error + logs.output[0])


if __name__ == "__main__":
    unittest.main()
