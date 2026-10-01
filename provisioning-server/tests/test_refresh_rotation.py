import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.store import Store


class RefreshRotationTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.store = Store(
            str(Path(self.tempdir.name) / "provisioning.db"),
            retry_key="unit-test-persistent-retry-key",
            retry_grace_seconds=30,
        )
        self.device = self.store.create_device(
            {
                "installation_id": "test-installation-123",
                "platform": "ios",
                "device_type": "mobile",
                "device_name": "Test phone",
                "app_version": "0.3.0",
                "app_build": 37,
                "os_version": "test",
            },
            {"version": 1, "telephony": {"extension": "1001"}},
            None,
        )
        self.device_id = self.device["id"]
        self.access, self.refresh, _ = self.store.issue_tokens(self.device_id, 900)

    def test_rotation_replay_and_stale_token_rejection(self):
        first = self.store.rotate_refresh(self.refresh, 900)
        self.assertIsNotNone(first)
        second = self.store.rotate_refresh(self.refresh, 900)
        self.assertIsNotNone(second)
        self.assertEqual(first[1:3], second[1:3])
        self.assertIsNotNone(self.store.authenticate_access(first[1]))

        next_pair = self.store.rotate_refresh(first[2], 900)
        self.assertIsNotNone(next_pair)
        # Once a successor has been rotated, its predecessor cannot be replayed.
        self.assertIsNone(self.store.rotate_refresh(self.refresh, 900))

    def test_revocation_invalidates_rotation_and_replay(self):
        result = self.store.rotate_refresh(self.refresh, 900)
        self.assertIsNotNone(result)
        self.assertTrue(self.store.set_device_state(self.device_id, "revoked"))
        self.assertIsNone(self.store.rotate_refresh(self.refresh, 900))
        self.assertIsNone(self.store.rotate_refresh(result[2], 900))

    def test_invalid_token_does_not_rotate(self):
        self.assertIsNone(self.store.rotate_refresh("invalid-token", 900))
        self.assertIsNotNone(self.store.rotate_refresh(self.refresh, 900))

    def test_failed_rotation_preserves_original_refresh_token(self):
        from app.store import hash_secret
        calls = 0

        def fail_successor_hash(value):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("Simulated database write failure")
            return hash_secret(value)

        with patch("app.store.hash_secret", side_effect=fail_successor_hash):
            with self.assertRaises(RuntimeError):
                self.store.rotate_refresh(self.refresh, 900)
        # The update to revoke the original credential must roll back.
        self.assertIsNotNone(self.store.rotate_refresh(self.refresh, 900))

    def test_rotation_without_retry_key_is_still_atomic(self):
        other = Store(str(Path(self.tempdir.name) / "provisioning.db"))
        rotated = other.rotate_refresh(self.refresh, 900)
        self.assertIsNotNone(rotated)
        self.assertIsNone(other.rotate_refresh(self.refresh, 900))


if __name__ == "__main__":
    unittest.main()
