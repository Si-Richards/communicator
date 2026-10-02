import os
import tempfile
import unittest
from pathlib import Path

# Importing the ASGI module initialises the store. Use an isolated test DB.
_test_directory = tempfile.TemporaryDirectory()
os.environ.setdefault(
    "PROVISIONING_DATABASE", str(Path(_test_directory.name) / "route-test.db")
)

from app.main import app, admin_app  # noqa: E402


class RouteIsolationTests(unittest.TestCase):
    def test_no_admin_routes_on_public_app(self):
        public_paths = {route.path for route in app.routes}
        self.assertFalse(any(path.startswith("/api/v1/admin/") for path in public_paths))
        self.assertIn("/api/v1/device/activate", public_paths)
        self.assertIn("/api/v1/device/token/refresh", public_paths)
        self.assertNotIn("/api/v1/admin/devices", app.openapi()["paths"])

    def test_no_device_routes_on_admin_app(self):
        admin_paths = {route.path for route in admin_app.routes}
        self.assertTrue(any(path.startswith("/api/v1/admin/") for path in admin_paths))
        self.assertNotIn("/api/v1/device/token/refresh", admin_paths)
        self.assertNotIn("/api/v1/device/activate", admin_paths)
        self.assertIn("/api/v1/admin/devices", admin_app.openapi()["paths"])
        self.assertIn("/health", admin_paths)


if __name__ == "__main__":
    unittest.main()
