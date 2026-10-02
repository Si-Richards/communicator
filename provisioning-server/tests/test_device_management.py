import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.store import Store


class DeviceManagementTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(str(Path(self.directory.name) / "test.db"), retry_key="test-key")
        self.descriptor = {
            "installation_id": "installation-001",
            "platform": "ios",
            "device_type": "mobile",
            "device_name": "Test iPhone",
            "app_version": "0.3",
            "app_build": 37,
            "os_version": "test",
        }
        self.config_factory = lambda src: {"version": 1, "telephony": {"extension": src["extension"]}}
        self.code_id, self.code, _ = self.store.create_activation({"extension": "201"}, 900)

    def activate(self, code=None):
        return self.store.activate_device(
            code or self.code, self.descriptor, self.config_factory, None, 900,
        )

    def test_atomic_activation_and_duplicate_does_not_consume_code(self):
        first, error = self.activate()
        self.assertIsNone(error)
        self.assertIsNotNone(self.store.authenticate_access(first[1]))
        self.assertEqual(self.store.get_device(first[0])["installation_id"], "installation-001")
        _, second_code, _ = self.store.create_activation({"extension": "202"}, 900)
        duplicate, error = self.activate(second_code)
        self.assertIsNone(duplicate)
        self.assertEqual(error, "installation_already_registered")
        self.assertTrue(self.store.set_device_state(first[0], "retired"))
        replacement, error = self.activate(second_code)
        self.assertIsNone(error)
        self.assertNotEqual(replacement[0], first[0])
        self.assertIsNone(self.store.authenticate_access(first[1]))

    def test_failure_preserves_code_and_does_not_create_device(self):
        def fail_configuration(_):
            raise RuntimeError("Configuration unavailable")

        with self.assertRaises(RuntimeError):
            self.store.activate_device(self.code, self.descriptor, fail_configuration, None, 900)
        result, error = self.activate()
        self.assertIsNone(error)
        self.assertIsNotNone(result)

    def test_inventory_does_not_expose_config_or_push(self):
        result, error = self.activate()
        self.assertIsNone(error)
        page = self.store.list_devices(state="active", query="iPhone")
        self.assertEqual(page["total"], 1)
        self.assertNotIn("config_json", page["items"][0])
        self.assertNotIn("push_json", page["items"][0])
        self.assertEqual(self.store.list_devices(state="locked")["total"], 0)

    def test_housekeeping_defaults_to_dry_run(self):
        self.activate()
        with self.store._connect() as conn:
            conn.execute("UPDATE access_tokens SET expires_at = '2000-01-01T00:00:00Z', created_at = '2000-01-01T00:00:00Z'")
        preview = self.store.housekeeping(retention_days=90)
        self.assertEqual(preview["deleted_or_eligible"]["access_tokens"], 1)
        with self.store._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM access_tokens").fetchone()[0], 1)
        applied = self.store.housekeeping(retention_days=90, dry_run=False)
        self.assertEqual(applied["deleted_or_eligible"]["access_tokens"], 1)
        with self.store._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM access_tokens").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
