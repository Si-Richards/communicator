"""Regression tests for SIP registration and outbound error handling."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.janus import JanusSipSession, SipRegistrationError
from app.main import app
from app.config import settings


class JanusRegistrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_rejected_registration_ends_wait_immediately(self):
        session = JanusSipSession(
            SimpleNamespace(), AsyncMock(), AsyncMock()
        )
        session._registration_error = SipRegistrationError(904)
        session._registration_finished.set()
        with self.assertRaises(SipRegistrationError) as raised:
            await session.wait_registered(timeout=0.1)
        self.assertEqual(raised.exception.code, "904")

    async def test_missing_response_times_out(self):
        session = JanusSipSession(
            SimpleNamespace(), AsyncMock(), AsyncMock()
        )
        with self.assertRaises(TimeoutError):
            await session.wait_registered(timeout=0.001)


class OutboundRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.headers = {"X-Gateway-Key": settings.gateway_api_key}
        self.body = {"target": "207", "sdp": "v=0\r\n"}

    def tearDown(self):
        self.client.close()

    def test_registration_rejected_returns_503(self):
        with patch("app.main.manager.start_outbound_call",
                   new=AsyncMock(side_effect=SipRegistrationError(904))):
            response = self.client.post(
                "/v1/devices/test-device/calls",
                json=self.body, headers=self.headers,
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "sip_registration_failed")
        self.assertEqual(response.json()["detail"]["janus_code"], "904")

    def test_registration_timeout_returns_504(self):
        with patch("app.main.manager.start_outbound_call",
                   new=AsyncMock(side_effect=TimeoutError())):
            response = self.client.post(
                "/v1/devices/test-device/calls",
                json=self.body, headers=self.headers,
            )
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()["detail"]["code"], "sip_registration_timeout")


if __name__ == "__main__":
    unittest.main()
