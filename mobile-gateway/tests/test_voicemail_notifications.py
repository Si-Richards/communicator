import tempfile
import unittest
from pathlib import Path

from cryptography.fernet import Fernet

from app.manager import MobileSessionManager
from app.models import DeviceRecord, DeviceRegistration
from app.store import DeviceStore


class _FakeApns:
    def __init__(self):
        self.sent = []

    async def send_notification(self, token, payload, *, collapse_id=None):
        self.sent.append((token, payload, collapse_id))
        return "production"


class _FakeStore:
    def __init__(self):
        self.valid = True
        self.invalidated = []

    def is_notification_token_valid(self, device_id, token):
        return self.valid

    def invalidate_notification_token(self, device_id, token, reason=""):
        self.invalidated.append((device_id, token, reason))
        return True


class NotificationTokenStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = DeviceStore(
            Path(self.tmp.name) / "gateway.db",
            Fernet.generate_key().decode(),
        )

    def _registration(self, *, notification_token=None):
        return DeviceRegistration(
            device_id="device-12345678",
            platform="ios",
            push_token="v" * 64,
            notification_token=notification_token,
            sip_username="tenant*207",
            sip_password="secret",
            sip_realm="hpbx.voicehost.co.uk",
            nickname="Reception",
        )

    def test_notification_token_survives_registration_without_new_value(self):
        first = self.store.upsert(
            self._registration(notification_token="n" * 64)
        )
        self.assertEqual(first.notification_token, "n" * 64)
        self.assertTrue(
            self.store.is_notification_token_valid(
                first.device_id,
                first.notification_token,
            )
        )

        second = self.store.upsert(self._registration())
        self.assertEqual(second.notification_token, "n" * 64)
        self.assertTrue(
            self.store.is_notification_token_valid(
                second.device_id,
                second.notification_token,
            )
        )


class VoicemailNotificationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = _FakeStore()
        self.apns = _FakeApns()
        self.manager = MobileSessionManager(self.store, self.apns)
        self.device = DeviceRecord(
            device_id="device-12345678",
            platform="ios",
            push_token="v" * 64,
            notification_token="n" * 64,
            sip_username="tenant*207",
            sip_password="secret",
            sip_realm="hpbx.voicehost.co.uk",
            sip_proxy=None,
            nickname="Reception",
            dnd=False,
        )

    async def test_only_increased_new_count_sends_notification(self):
        await self.manager._update_voicemail(
            self.device,
            {"waiting": False, "new_messages": 0, "old_messages": 0},
        )
        self.assertEqual(self.apns.sent, [])

        await self.manager._update_voicemail(
            self.device,
            {"waiting": True, "new_messages": 1, "old_messages": 0},
        )
        self.assertEqual(len(self.apns.sent), 1)
        self.assertEqual(
            self.apns.sent[0][1]["aps"]["alert"]["title"],
            "New voicemail",
        )

        await self.manager._update_voicemail(
            self.device,
            {"waiting": True, "new_messages": 1, "old_messages": 0},
        )
        self.assertEqual(len(self.apns.sent), 1)

        await self.manager._update_voicemail(
            self.device,
            {"waiting": True, "new_messages": 2, "old_messages": 0},
        )
        self.assertEqual(len(self.apns.sent), 2)


if __name__ == "__main__":
    unittest.main()
