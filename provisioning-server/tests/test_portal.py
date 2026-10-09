import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.portal import make_router, verify_password
from app.store import Store


class PortalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "portal.db"))
        salt = b"0123456789abcdef"
        digest = hashlib.pbkdf2_hmac("sha256", b"test-only-password", salt, 200000)
        self.settings = SimpleNamespace(
            portal_secret="test-only-secret-at-least-thirty-two-characters",
            portal_password_hash="pbkdf2_sha256$200000$" + salt.hex() + "$" + digest.hex(),
            portal_origin="https://testserver",
            randy_url="https://randy.example.test",
            janus_url="wss://janus.example.test",
            activation_ttl_seconds=900,
        )
        app = FastAPI()
        app.include_router(make_router(self.store, self.settings))
        self.client = TestClient(app, base_url="https://testserver")

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def test_authentication_csrf_and_session(self):
        self.assertEqual(self.client.get("/portal/api/devices").status_code, 401)
        self.assertFalse(verify_password("wrong", self.settings.portal_password_hash))
        self.assertTrue(verify_password("test-only-password", self.settings.portal_password_hash))
        bad = self.client.post("/portal/api/login", json={"password": "wrong"})
        self.assertEqual(bad.status_code, 401)
        login = self.client.post("/portal/api/login", json={"password": "test-only-password"})
        self.assertEqual(login.status_code, 200)
        self.assertIn("httponly", login.headers["set-cookie"].lower())
        self.assertIn("secure", login.headers["set-cookie"].lower())
        self.assertEqual(self.client.get("/portal/api/devices").status_code, 200)
        blocked = self.client.post("/portal/api/activations", json={"extension": "207"})
        self.assertEqual(blocked.status_code, 403)
        csrf = self.client.get("/portal/api/session").json()["csrf"]
        created = self.client.post(
            "/portal/api/activations", json={"extension": "207"},
            headers={"X-CSRF-Token": csrf, "Origin": "https://testserver"},
        )
        self.assertEqual(created.status_code, 201)
        self.assertTrue(created.json()["code"].startswith("VH"))
        self.assertEqual(self.client.post(
            "/portal/api/logout", json={},
            headers={"X-CSRF-Token": csrf},
        ).status_code, 200)
        self.assertEqual(self.client.get("/portal/api/devices").status_code, 401)

    def test_device_detail_redacts_sip_password(self):
        device = self.store.create_device(
            {
                "installation_id": "installation-portal-1",
                "platform": "ios",
                "device_type": "mobile",
                "device_name": "Reception iPhone",
                "app_version": "0.3",
                "app_build": 37,
                "os_version": "test",
            },
            {
                "version": 1,
                "connection_strategy": "managed_mobile",
                "device": {"display_name": "Reception", "state": "active"},
                "services": {"randy_url": self.settings.randy_url},
                "telephony": {
                    "mode": "randy_managed",
                    "extension": "207",
                    "sip": {
                        "username": "tenant*207",
                        "password": "never-return-this",
                        "realm": "hpbx.voicehost.co.uk",
                        "proxy": None,
                    },
                },
                "messaging": {"enabled": True, "jid": "207@ejabberd.voicehost.io",
                    "password": "never-return-messaging-secret", "websocket": "wss://ejabberd.voicehost.io/websocket"},
                "features": {},
                "policy": {},
            },
            None,
        )
        self.client.post(
            "/portal/api/login",
            json={"password": "test-only-password"},
        )
        response = self.client.get("/portal/api/devices/" + device["id"])
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["sip_username"], "tenant*207")
        self.assertTrue(body["sip_password_configured"])
        self.assertNotIn("sip_password", body)
        self.assertNotIn("never-return-this", response.text)
        self.assertNotIn("never-return-messaging-secret", response.text)
        self.assertTrue(body["messaging_password_configured"])
        self.assertEqual(body["messaging_jid"], "207@ejabberd.voicehost.io")

    def test_automatic_account_status_does_not_expose_generated_secret(self):
        device = self.store.create_device({
            "installation_id": "automatic-portal-1", "platform": "ios",
            "device_type": "mobile", "app_version": "test", "app_build": 37,
        }, {"version": 1, "telephony": {"extension": "207", "sip": {"username": "10000*207"}},
            "messaging": {"enabled": True, "managed": True,
                "jid": "10000*207@ejabberd.voicehost.io", "websocket": "wss://ejabberd.voicehost.io/websocket"}}, None)
        password = device["config"]["messaging"]["password"]
        self.client.post("/portal/api/login", json={"password": "test-only-password"})
        response = self.client.get("/portal/api/devices/" + device["id"])
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["messaging_managed"])
        self.assertEqual(response.json()["messaging_account"], {
            "status": "pending", "error": None, "active_devices": 1})
        self.assertNotIn(password, response.text)

    def test_misconfiguration_fails_closed(self):
        self.settings.portal_secret = ""
        app = FastAPI()
        app.include_router(make_router(self.store, self.settings))
        with TestClient(app, base_url="https://testserver") as client:
            self.assertEqual(client.post(
                "/portal/api/login", json={"password": "test-only-password"}
            ).status_code, 503)


if __name__ == "__main__":
    unittest.main()
