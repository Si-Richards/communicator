"""Standard APNs alerts; separate from the gateway's VoIP provider."""
import hashlib
import logging
from pathlib import Path
import time
import uuid

import httpx
import jwt


class APNSError(RuntimeError):
    def __init__(self, status, reason, retry_after=0):
        self.status = status
        self.reason = reason
        self.retry_after = retry_after
        super().__init__(f"APNs rejected notification (HTTP {status}, {reason}).")


class APNSClient:
    def __init__(self, settings, transport=None):
        # httpx INFO logs contain the device token in the request URL.
        logging.getLogger("httpx").setLevel(logging.WARNING)
        self.settings = settings
        self._key = Path(settings.apns_key_path).read_text()
        # Fail at startup if credentials are missing/invalid, without logging them.
        self._jwt_time = 0
        self._jwt_token = None
        self._jwt()
        self.client = httpx.Client(http2=True, timeout=5, trust_env=False,
                                   follow_redirects=False, transport=transport)

    def close(self):
        self.client.close()

    def _jwt(self):
        now = int(time.time())
        if not self._jwt_token or now - self._jwt_time >= 3000:
            self._jwt_token = jwt.encode({"iss": self.settings.apns_team_id, "iat": now}, self._key,
                algorithm="ES256", headers={"kid": self.settings.apns_key_id})
            self._jwt_time = now
        return self._jwt_token

    def send(self, target, event, payload):
        host = "api.sandbox.push.apple.com" if target["environment"] == "sandbox" else "api.push.apple.com"
        conversation = hashlib.sha256((event["jid"] + "|" + event["peer"]).encode()).hexdigest()
        response = self.client.post(f"https://{host}/3/device/{target['token']}", json=payload,
            headers={"authorization": "bearer " + self._jwt(), "apns-topic": self.settings.apns_bundle_id,
                "apns-push-type": "alert", "apns-priority": "10",
                "apns-expiration": str(event["created"] + 900), "apns-collapse-id": conversation,
                "apns-id": str(uuid.uuid5(uuid.NAMESPACE_URL, event["event_id"]))})
        if response.status_code == 200:
            return
        reason = "Rejected"
        try:
            value = response.json().get("reason")
            if value in {"Unregistered", "BadDeviceToken", "DeviceTokenNotForTopic", "TooManyRequests",
                         "ExpiredProviderToken", "InvalidProviderToken", "BadTopic", "TopicDisallowed",
                         "PayloadTooLarge", "InternalServerError", "ServiceUnavailable", "Shutdown"}:
                reason = value
        except (ValueError, AttributeError, TypeError):
            pass
        if reason == "ExpiredProviderToken":
            self._jwt_token = None
        try:
            retry = min(900, max(0, int(response.headers.get("retry-after", "0"))))
        except ValueError:
            retry = 0
        raise APNSError(response.status_code, reason, retry)
