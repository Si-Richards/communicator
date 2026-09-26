import logging
import time

import httpx
import jwt

from .config import settings

logger = logging.getLogger('uvicorn.error')


class APNSError(RuntimeError):
    def __init__(self, status: int, reason: str):
        self.status = status
        self.reason = reason
        super().__init__(f'APNs {status}: {reason}')


class APNSClient:
    def __init__(self):
        self._token: str | None = None
        self._token_time = 0.0
        self._key: str | None = None
        self._token_environment: dict[str, bool] = {}

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

    @staticmethod
    def _host(sandbox: bool) -> str:
        return 'api.sandbox.push.apple.com' if sandbox else 'api.push.apple.com'

    @staticmethod
    def _environment_name(sandbox: bool) -> str:
        return 'sandbox' if sandbox else 'production'

    async def _send(self, token: str, payload: dict, sandbox: bool) -> httpx.Response:
        headers = {
            'authorization': f'bearer {self._jwt()}',
            'apns-topic': f'{settings.apns_bundle_id}.voip',
            'apns-push-type': 'voip',
            'apns-priority': '10',
            'apns-expiration': '0',
        }
        async with httpx.AsyncClient(http2=True, timeout=10) as client:
            return await client.post(
                f'https://{self._host(sandbox)}/3/device/{token}',
                headers=headers,
                json=payload,
            )

    @staticmethod
    def _failure_reason(response: httpx.Response) -> str:
        try:
            body = response.json()
            if isinstance(body, dict):
                reason = body.get('reason')
                if reason:
                    return str(reason)
        except Exception:
            pass
        return response.text.strip() or 'UnknownError'

    async def send_voip(self, token: str, payload: dict) -> str:
        if not self.configured:
            raise RuntimeError('APNs is not configured')

        preferred = self._token_environment.get(token, settings.apns_sandbox)
        environments = [preferred]
        if settings.apns_fallback_environment:
            alternate = not preferred
            if alternate not in environments:
                environments.append(alternate)

        last_status = 0
        last_reason = 'UnknownError'

        for index, sandbox in enumerate(environments):
            response = await self._send(token, payload, sandbox)
            if response.status_code == 200:
                self._token_environment[token] = sandbox
                environment = self._environment_name(sandbox)
                logger.info(
                    '[VH-DIAG] event=apns_sent environment=%s',
                    environment,
                )
                return environment

            last_status = response.status_code
            last_reason = self._failure_reason(response)
            environment = self._environment_name(sandbox)
            logger.warning(
                '[VH-DIAG] event=apns_failed environment=%s status=%s reason=%s',
                environment,
                last_status,
                last_reason,
            )

            # A development token sent to production (or vice versa) is
            # rejected as BadDeviceToken. Retry the opposite environment once.
            if not (
                index == 0
                and settings.apns_fallback_environment
                and response.status_code == 400
                and last_reason == 'BadDeviceToken'
            ):
                break

        raise APNSError(last_status, last_reason)
