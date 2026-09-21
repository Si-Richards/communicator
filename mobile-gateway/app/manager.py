import asyncio
import hashlib
import logging
import uuid
from dataclasses import dataclass, field

from .apns import APNSClient
from .janus import JanusSipSession
from .models import DeviceRecord

logger = logging.getLogger('uvicorn.error')


def _safe_ref(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:10]


@dataclass
class CallRuntime:
    id: str
    device_id: str
    caller: str
    display_name: str | None
    offer_sdp: str
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    buffered: list[dict] = field(default_factory=list)

    async def publish(self, event: dict):
        if not self.subscribers:
            self.buffered.append(event)
            self.buffered = self.buffered[-100:]
        for queue in tuple(self.subscribers):
            await queue.put(event)


class MobileSessionManager:
    def __init__(self, store, apns: APNSClient):
        self.store = store
        self.apns = apns
        self.sessions: dict[str, JanusSipSession] = {}
        self.calls: dict[str, CallRuntime] = {}
        self.device_call: dict[str, str] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def restore(self):
        for device in self.store.all():
            asyncio.create_task(self.ensure_session(device))

    async def ensure_session(self, device: DeviceRecord):
        lock = self._locks.setdefault(device.device_id, asyncio.Lock())
        async with lock:
            existing = self.sessions.get(device.device_id)
            if existing and self._same_sip_registration(existing.device, device):
                reader = getattr(existing, '_reader_task', None)
                if reader is not None and not reader.done():
                    # Re-provisioning on app cold start/token refresh must not
                    # destroy a Janus session that may own an incoming INVITE.
                    existing.device = device
                    logger.info(
                        '[VH-DIAG] event=session_reused device=%s',
                        _safe_ref(device.device_id),
                    )
                    return

            existing = self.sessions.pop(device.device_id, None)
            if existing:
                await existing.stop()

            async def plugin(data, jsep):
                await self._plugin_event(session.device, session, data, jsep)

            async def trickle(candidate):
                call = self._current_call(session.device.device_id)
                if call:
                    logger.info(
                        '[VH-DIAG] event=janus_candidate call=%s completed=%s',
                        _safe_ref(call.id),
                        bool(candidate.get('completed')),
                    )
                    await call.publish({'type': 'trickle', 'candidate': candidate})

            session = JanusSipSession(device, plugin, trickle)
            self.sessions[device.device_id] = session
            logger.info(
                '[VH-DIAG] event=session_start device=%s',
                _safe_ref(device.device_id),
            )
            try:
                await session.start()
            except Exception:
                self.sessions.pop(device.device_id, None)
                raise

    @staticmethod
    def _same_sip_registration(current: DeviceRecord, updated: DeviceRecord) -> bool:
        return (
            current.sip_username == updated.sip_username
            and current.sip_password == updated.sip_password
            and current.sip_realm == updated.sip_realm
            and current.sip_proxy == updated.sip_proxy
        )

    async def _plugin_event(self, device, session, data, jsep):
        result = data.get('result') or {}
        event = result.get('event')
        if event == 'incomingcall':
            if device.dnd:
                await session.decline(486)
                return
            caller_uri = str(result.get('username') or 'Unknown')
            caller = caller_uri.replace('sip:', '').split('@', 1)[0]
            display = result.get('displayname')
            offer = (jsep or {}).get('sdp') or ''
            call_id = str(uuid.uuid4())
            call = CallRuntime(call_id, device.device_id, caller, display, offer)
            self.calls[call_id] = call
            logger.info(
                '[VH-DIAG] event=incoming_call call=%s device=%s offer_sdp=%s',
                _safe_ref(call_id),
                _safe_ref(device.device_id),
                bool(offer),
            )
            self.device_call[device.device_id] = call_id
            await self.apns.send_voip(device.push_token, {
                'aps': {'content-available': 1},
                'id': call_id,
                'nameCaller': display or caller,
                'handle': caller,
                'isVideo': False,
                'extra': {'call_id': call_id},
            })
            return

        call = self._current_call(device.device_id)
        if not call:
            return
        if event in {'ringing', 'progress', 'accepted'}:
            logger.info(
                '[VH-DIAG] event=janus_%s call=%s jsep=%s',
                event,
                _safe_ref(call.id),
                bool(jsep),
            )
            await call.publish({'type': event, 'jsep': jsep, 'result': result})
        elif event == 'hangup':
            await call.publish({'type': 'hangup', 'reason': result.get('reason')})
            self.device_call.pop(device.device_id, None)

    def _current_call(self, device_id):
        call_id = self.device_call.get(device_id)
        return self.calls.get(call_id) if call_id else None

    def get_call(self, call_id: str) -> CallRuntime:
        call = self.calls.get(call_id)
        if not call:
            raise KeyError(call_id)
        return call

    def _session_for_call(self, call_id: str):
        call = self.get_call(call_id)
        session = self.sessions.get(call.device_id)
        if not session:
            raise RuntimeError('Device Janus session is unavailable')
        return session

    async def answer(self, call_id: str, sdp: str):
        logger.info(
            '[VH-DIAG] event=answer_received call=%s sdp_length=%s',
            _safe_ref(call_id),
            len(sdp),
        )
        await self._session_for_call(call_id).accept(sdp)

    async def decline(self, call_id: str):
        await self._session_for_call(call_id).decline(486)

    async def hangup(self, call_id: str):
        await self._session_for_call(call_id).hangup()

    async def candidate(self, call_id: str, candidate: dict):
        logger.info(
            '[VH-DIAG] event=handset_candidate call=%s completed=%s',
            _safe_ref(call_id),
            bool(candidate.get('completed')),
        )
        await self._session_for_call(call_id).trickle(candidate)
