import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

_test_directory = tempfile.TemporaryDirectory()
os.environ.setdefault("PROVISIONING_DATABASE", str(Path(_test_directory.name) / "messaging-route.db"))
from app import main
from app.models import AdminActivationRequest, AdminDeviceConfigurationRequest
from app.store import Store


class MessagingConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "messaging.db"))
        self.patch = patch.object(main, "store", self.store)
        self.patch.start()
        self.source = dict(extension="207", messaging_enabled=True,
            messaging_jid="207@ejabberd.voicehost.io", messaging_password="dedicated-secret")
        self.device = self.store.create_device({
            "installation_id": "messaging-installation-1", "platform": "ios",
            "device_type": "mobile", "app_version": "0.3", "app_build": 37,
        }, main.build_configuration(self.source), None)

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def update(self, **fields):
        return main.update_managed_configuration(self.device["id"],
            AdminDeviceConfigurationRequest(extension="207", **fields))

    def test_old_activation_is_disabled_and_new_activation_has_dedicated_account(self):
        self.assertEqual(main.build_configuration({"extension": "207"})["messaging"], {"enabled": False})
        request = AdminActivationRequest(**self.source)
        config = main.build_configuration(request.model_dump())
        self.assertEqual(config["messaging"]["password"], "dedicated-secret")
        self.assertEqual(config["messaging"]["websocket"], "wss://ejabberd.voicehost.io/websocket")
        self.assertNotIn("sip", config["telephony"])

    def test_edit_retains_password_and_rotates_it_without_affecting_telephony(self):
        updated = self.update(messaging_password="")
        self.assertEqual(updated["config"]["messaging"]["password"], "dedicated-secret")
        rotated = self.update(messaging_password="rotated-secret")
        self.assertEqual(rotated["config"]["messaging"]["password"], "rotated-secret")
        self.assertEqual(rotated["configuration_version"], 3)
        self.assertEqual(rotated["config"]["telephony"]["extension"], "207")

    def test_new_identity_or_server_cannot_inherit_existing_password(self):
        for changed in [dict(messaging_jid="208@ejabberd.voicehost.io"),
                        dict(messaging_websocket="wss://other.example/websocket")]:
            with self.assertRaises(HTTPException) as caught:
                self.update(**changed)
            self.assertEqual(caught.exception.status_code, 422)
        changed = self.update(messaging_jid="208@ejabberd.voicehost.io", messaging_password="new-user-secret")
        self.assertEqual(changed["config"]["messaging"]["jid"], "208@ejabberd.voicehost.io")

    def test_disable_removes_credentials_from_device_configuration(self):
        updated = self.update(messaging_enabled=False)
        self.assertEqual(updated["config"]["messaging"], {"enabled": False})

    def test_invalid_activation_cannot_echo_passwords(self):
        main.app.dependency_overrides[main.admin_auth] = lambda: None
        try:
            client = TestClient(main.admin_app)
            for endpoint in ["ws://server/websocket", "wss://user:secret@server/websocket"]:
                response = client.post("/api/v1/admin/activations", json={
                    **self.source, "messaging_websocket": endpoint})
                self.assertEqual(response.status_code, 422)
                self.assertNotIn("dedicated-secret", response.text)
                self.assertNotIn("user:secret", response.text)
            client.close()
        finally:
            main.app.dependency_overrides.clear()

    def test_enabled_messaging_requires_valid_account_and_own_password(self):
        for fields in [dict(messaging_password=None), dict(messaging_jid="207/domain"),
                       dict(messaging_jid="207@domain/resource")]:
            with self.assertRaises(ValidationError):
                AdminActivationRequest(**{**self.source, **fields})


if __name__ == "__main__":
    unittest.main()
