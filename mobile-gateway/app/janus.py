import asyncio
import json
import logging
import secrets
from collections.abc import Awaitable, Callable

import websockets

from .config import settings
from .models import DeviceRecord

PluginCallback = Callable[[dict, dict | None], Awaitable[None]]
TrickleCallback = Callable[[dict], Awaitable[None]]

logger = logging.getLogger('uvicorn.error')


class JanusSipSession:
    def __init__(
        self,
        device: DeviceRecord,
        on_plugin: PluginCallback,
        on_trickle: TrickleCallback,
        helper_master_id: int | None = None,
    ):
        self.device = device
        self.on_plugin = on_plugin
        self.on_trickle = on_trickle
        self.helper_master_id = helper_master_id
        self.ws = None
        self.session_id: int | None = None
        self.handle_id: int | None = None
        self._waiters: dict[str, asyncio.Future] = {}
        self._reader_task = None
        self._keepalive_task = None
        self.master_id: int | None = helper_master_id
        self._registered = asyncio.Event()

    async def start(self):
        self.ws = await websockets.connect(
            settings.janus_url,
            subprotocols=['janus-protocol'],
            ping_interval=20,
            ping_timeout=20,
        )
        self._reader_task = asyncio.create_task(self._reader())
        created = await self._request({'janus': 'create'})
        self.session_id = int(created['data']['id'])
        attached = await self._request({
            'janus': 'attach', 'session_id': self.session_id, 'plugin': 'janus.plugin.sip'
        })
        self.handle_id = int(attached['data']['id'])
        await self._message(self._register_body())
        self._keepalive_task = asyncio.create_task(self._keepalive())

    async def stop(self):
        for task in (self._keepalive_task, self._reader_task):
            if task:
                task.cancel()
        if self.ws:
            await self.ws.close()
        self.ws = None

    async def wait_registered(self, timeout: float = 10):
        await asyncio.wait_for(self._registered.wait(), timeout)
        return self.master_id

    async def call(self, uri: str, sdp: str):
        await self._message(
            {'request': 'call', 'uri': uri},
            {'type': 'offer', 'sdp': sdp, 'trickle': True},
        )

    async def accept(self, sdp: str):
        await self._message({'request': 'accept'}, {'type': 'answer', 'sdp': sdp, 'trickle': True})

    async def decline(self, code: int = 486):
        await self._message({'request': 'decline', 'code': code})

    async def hangup(self):
        await self._message({'request': 'hangup'})

    async def hold(self):
        await self._message({'request': 'hold', 'direction': 'sendonly'})

    async def unhold(self):
        await self._message({'request': 'unhold'})

    async def transfer(self, uri: str, replace: str | None = None):
        body = {'request': 'transfer', 'uri': uri}
        if replace:
            body['replace'] = replace
        await self._message(body)

    async def trickle(self, candidate: dict):
        await self._send({
            'janus': 'trickle', 'session_id': self.session_id,
            'handle_id': self.handle_id, 'candidate': candidate,
        })

    def _register_body(self):
        if self.helper_master_id is not None:
            return {
                'request': 'register',
                'type': 'helper',
                'username': f'sip:{self.device.sip_username}@{self.device.sip_realm}',
                'master_id': self.helper_master_id,
            }

        body = {
            'request': 'register',
            'username': f'sip:{self.device.sip_username}@{self.device.sip_realm}',
            'authuser': self.device.sip_username,
            'secret': self.device.sip_password,
            'display_name': self.device.nickname or self.device.sip_username,
        }
        if self.device.sip_proxy:
            body['proxy'] = self.device.sip_proxy
        return body

    async def _message(self, body: dict, jsep: dict | None = None):
        payload = {
            'janus': 'message', 'session_id': self.session_id,
            'handle_id': self.handle_id, 'body': body,
        }
        if jsep:
            payload['jsep'] = jsep
        await self._send(payload)

    async def _request(self, payload: dict) -> dict:
        tx = secrets.token_hex(8)
        payload['transaction'] = tx
        self._auth(payload)
        future = asyncio.get_running_loop().create_future()
        self._waiters[tx] = future
        await self.ws.send(json.dumps(payload))
        return await asyncio.wait_for(future, 10)

    async def _send(self, payload: dict):
        payload['transaction'] = secrets.token_hex(8)
        self._auth(payload)
        await self.ws.send(json.dumps(payload))

    def _auth(self, payload: dict):
        if settings.janus_api_secret:
            payload['apisecret'] = settings.janus_api_secret

    async def _reader(self):
        async for raw in self.ws:
            message = json.loads(raw)
            tx = message.get('transaction')
            if message.get('janus') == 'success' and tx in self._waiters:
                self._waiters.pop(tx).set_result(message)
                continue
            if message.get('janus') == 'error' and tx in self._waiters:
                self._waiters.pop(tx).set_exception(RuntimeError(str(message.get('error'))))
                continue
            if message.get('janus') == 'event':
                data = (message.get('plugindata') or {}).get('data') or {}
                result = data.get('result') or {}
                if result.get('event') == 'registered':
                    value = result.get('master_id')
                    if value is not None:
                        self.master_id = int(value)
                    self._registered.set()
                try:
                    await self.on_plugin(data, message.get('jsep'))
                except Exception:
                    logger.exception(
                        '[VH-DIAG] event=janus_plugin_callback_failed'
                    )
                continue
            if message.get('janus') == 'trickle':
                candidate = message.get('candidate') or {}
                try:
                    await self.on_trickle(candidate)
                except Exception:
                    logger.exception(
                        '[VH-DIAG] event=janus_trickle_callback_failed'
                    )

    async def _keepalive(self):
        while True:
            await asyncio.sleep(25)
            await self._send({'janus': 'keepalive', 'session_id': self.session_id})
