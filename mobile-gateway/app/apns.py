import time
import httpx
import jwt

from .config import settings


class APNSClient:
    def __init__(self):
        self._token: str | None = None
        self._token_time = 0.0
        self._key: str | None = None

    @property
    def configured(self) -> bool:
        return bool(settings.apns_team_id and settings.apns_key_id and settings.apns_bundle_id)

    def _jwt(self) -> str:
        now = time.time()
        if self._token and now - self._token_time < 3000:
            return self._token
        if self._key is None:
            self._key = settings.apns_key_path.read_text()
        self._token = jwt.encode(
            {'iss': settings.apns_team_id, 'iat': int(now)},
            self._key,
            algorithm='ES256',
            headers={'kid': settings.apns_key_id},
        )
        self._token_time = now
        return self._token

    async def send_voip(self, token: str, payload: dict):
        if not self.configured:
            raise RuntimeError('APNs is not configured')
        host = 'api.sandbox.push.apple.com' if settings.apns_sandbox else 'api.push.apple.com'
        headers = {
            'authorization': f'bearer {self._jwt()}',
            'apns-topic': f'{settings.apns_bundle_id}.voip',
            'apns-push-type': 'voip',
            'apns-priority': '10',
            'apns-expiration': '0',
        }
        async with httpx.AsyncClient(http2=True, timeout=10) as client:
            response = await client.post(
                f'https://{host}/3/device/{token}',
                headers=headers,
                json=payload,
            )
        if response.status_code != 200:
            raise RuntimeError(f'APNs {response.status_code}: {response.text}')
