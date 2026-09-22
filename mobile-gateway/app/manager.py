import asyncio
import hashlib
import logging
import re
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
    sip_call_id: str | None = None
    transfer_mode: str | None = None
    transfer_target: str | None = None
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    buffered: list[dict] = field(default_factory=list)

    async def publish(self, event: dict):
        if not self.subscribers:
            self.buffered.append(event)
            self.buffered = self.buffered[-100:]
        for queue in tuple(self.subscribers):
            await queue.put(event)


@dataclass
class TransferRuntime:
    id: str
    original_call_id: str
    device_id: str
    target: str
    helper: JanusSipSession
    sip_call_id: str | None = None
    connected: bool = False
    closing: bool = False
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
        self.transfers: dict[str, TransferRuntime] = {}
        self.device_transfer: dict[str, str] = {}
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
            call = CallRuntime(
                call_id,
                device.device_id,
                caller,
                display,
                offer,
                sip_call_id=data.get('call_id'),
            )
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

        if event == 'transferring':
            await call.publish({'type': 'transfer', 'state': 'transferring'})
            transfer = self._current_transfer(device.device_id)
            if transfer:
                await transfer.publish({'type': 'transfer', 'state': 'transferring'})
            return

        if event == 'notify' and call.transfer_mode:
            status = self._refer_status(result.get('content'))
            await call.publish({
                'type': 'transfer',
                'state': 'notify',
                'status': status,
            })
            transfer = self._current_transfer(device.device_id)
            if transfer:
                await transfer.publish({
                    'type': 'transfer',
                    'state': 'notify',
                    'status': status,
                })
            if status is not None and 200 <= status < 300:
                asyncio.create_task(self._finish_transfer_success(call.id))
            elif status is not None and status >= 300:
                asyncio.create_task(self._finish_transfer_failure(call.id, status))
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
            transfer = self._current_transfer(device.device_id)
            if transfer and not transfer.closing:
                asyncio.create_task(
                    self.cancel_attended_transfer(transfer.id, restore_original=False)
                )

    def _current_call(self, device_id):
        call_id = self.device_call.get(device_id)
        return self.calls.get(call_id) if call_id else None

    def _current_transfer(self, device_id: str):
        transfer_id = self.device_transfer.get(device_id)
        return self.transfers.get(transfer_id) if transfer_id else None

    @staticmethod
    def _refer_status(content) -> int | None:
        if not content:
            return None
        match = re.search(r'SIP/2\.0\s+(\d{3})', str(content))
        return int(match.group(1)) if match else None

    @staticmethod
    def _target_uri(device: DeviceRecord, target: str) -> str:
        value = target.strip()
        if value.startswith('sip:') or value.startswith('sips:'):
            return value
        return f'sip:{value}@{device.sip_realm}'

    async def blind_transfer(self, call_id: str, target: str):
        call = self.get_call(call_id)
        if call.transfer_mode:
            raise RuntimeError('A transfer is already in progress')
        session = self._session_for_call(call_id)
        uri = self._target_uri(session.device, target)
        call.transfer_mode = 'blind'
        call.transfer_target = target
        logger.info(
            '[VH-DIAG] event=blind_transfer_requested call=%s',
            _safe_ref(call_id),
        )
        await session.transfer(uri)

    async def start_attended_transfer(self, call_id: str, target: str, offer_sdp: str):
        call = self.get_call(call_id)
        master = self._session_for_call(call_id)
        await master.wait_registered()
        if master.master_id is None:
            raise RuntimeError('Janus SIP master session has no master_id')
        if self._current_transfer(call.device_id):
            raise RuntimeError('A transfer is already in progress')

        transfer_id = str(uuid.uuid4())
        runtime = None

        async def plugin(data, jsep):
            await self._helper_plugin_event(runtime, data, jsep)

        async def trickle(candidate):
            if runtime is None:
                return
            logger.info(
                '[VH-DIAG] event=transfer_janus_candidate transfer=%s completed=%s',
                _safe_ref(runtime.id),
                bool(candidate.get('completed')),
            )
            await runtime.publish({'type': 'trickle', 'candidate': candidate})

        helper = JanusSipSession(
            master.device,
            plugin,
            trickle,
            helper_master_id=master.master_id,
        )
        runtime = TransferRuntime(
            transfer_id,
            call_id,
            call.device_id,
            target.strip(),
            helper,
        )
        self.transfers[transfer_id] = runtime
        self.device_transfer[call.device_id] = transfer_id
        call.transfer_mode = 'attended'
        call.transfer_target = target.strip()

        try:
            await master.hold()
            await runtime.publish({'type': 'original', 'state': 'held'})
            await helper.start()
            await helper.wait_registered()
            await helper.call(
                self._target_uri(master.device, target),
                offer_sdp,
            )
            logger.info(
                '[VH-DIAG] event=attended_transfer_started call=%s transfer=%s',
                _safe_ref(call_id),
                _safe_ref(transfer_id),
            )
            return runtime
        except Exception:
            runtime.closing = True
            self.transfers.pop(transfer_id, None)
            self.device_transfer.pop(call.device_id, None)
            call.transfer_mode = None
            call.transfer_target = None
            try:
                await helper.stop()
            except Exception:
                pass
            try:
                await master.unhold()
            except Exception:
                pass
            raise

    async def _helper_plugin_event(self, transfer: TransferRuntime, data, jsep):
        if transfer is None or transfer.closing:
            return
        result = data.get('result') or {}
        event = result.get('event')
        sip_call_id = data.get('call_id')
        if sip_call_id:
            transfer.sip_call_id = str(sip_call_id)

        if event in {'calling', 'ringing', 'progress', 'accepted'}:
            if event == 'accepted':
                transfer.connected = True
            await transfer.publish({
                'type': event,
                'jsep': jsep,
                'result': result,
            })
            return

        if event == 'hangup':
            await transfer.publish({
                'type': 'hangup',
                'reason': result.get('reason'),
            })
            asyncio.create_task(self.cancel_attended_transfer(transfer.id))
            return

        if data.get('error'):
            await transfer.publish({
                'type': 'error',
                'reason': data.get('error'),
            })

    def get_transfer(self, transfer_id: str) -> TransferRuntime:
        transfer = self.transfers.get(transfer_id)
        if not transfer:
            raise KeyError(transfer_id)
        return transfer

    async def attended_candidate(self, transfer_id: str, candidate: dict):
        transfer = self.get_transfer(transfer_id)
        await transfer.helper.trickle(candidate)

    async def complete_attended_transfer(self, transfer_id: str):
        transfer = self.get_transfer(transfer_id)
        if not transfer.connected or not transfer.sip_call_id:
            raise RuntimeError('Consultation call is not connected')
        call = self.get_call(transfer.original_call_id)
        master = self._session_for_call(call.id)
        await transfer.publish({'type': 'transfer', 'state': 'completing'})
        logger.info(
            '[VH-DIAG] event=attended_transfer_complete_requested call=%s transfer=%s',
            _safe_ref(call.id),
            _safe_ref(transfer.id),
        )
        await master.transfer(
            self._target_uri(master.device, transfer.target),
            replace=transfer.sip_call_id,
        )

    async def cancel_attended_transfer(
        self,
        transfer_id: str,
        restore_original: bool = True,
        publish_cancelled: bool = True,
    ):
        transfer = self.transfers.get(transfer_id)
        if not transfer or transfer.closing:
            return
        transfer.closing = True
        call = self.calls.get(transfer.original_call_id)
        if publish_cancelled:
            try:
                await transfer.publish({'type': 'transfer', 'state': 'cancelled'})
            except Exception:
                pass
        try:
            await transfer.helper.hangup()
        except Exception:
            pass
        try:
            await transfer.helper.stop()
        except Exception:
            pass
        if restore_original and call:
            try:
                await self._session_for_call(call.id).unhold()
            except Exception:
                pass
            if publish_cancelled:
                try:
                    await call.publish({'type': 'transfer', 'state': 'cancelled'})
                except Exception:
                    pass
        self.transfers.pop(transfer_id, None)
        self.device_transfer.pop(transfer.device_id, None)
        if call:
            call.transfer_mode = None
            call.transfer_target = None

    async def _finish_transfer_success(self, call_id: str):
        call = self.calls.get(call_id)
        if not call:
            return
        transfer = self._current_transfer(call.device_id)
        try:
            await call.publish({'type': 'transfer', 'state': 'completed'})
        except Exception:
            pass

        if transfer:
            transfer.closing = True
            try:
                await transfer.publish({'type': 'transfer', 'state': 'completed'})
            except Exception:
                pass
            try:
                await transfer.helper.hangup()
            except Exception:
                pass
            await asyncio.sleep(0.2)
            try:
                await transfer.helper.stop()
            except Exception:
                pass
            self.transfers.pop(transfer.id, None)
            self.device_transfer.pop(call.device_id, None)

        try:
            await self._session_for_call(call_id).hangup()
        except Exception:
            pass
        call.transfer_mode = None
        call.transfer_target = None

    async def _finish_transfer_failure(self, call_id: str, status: int):
        call = self.calls.get(call_id)
        if not call:
            return
        transfer = self._current_transfer(call.device_id)
        try:
            await call.publish({
                'type': 'transfer',
                'state': 'failed',
                'status': status,
            })
        except Exception:
            pass
        if transfer:
            try:
                await transfer.publish({
                    'type': 'transfer',
                    'state': 'failed',
                    'status': status,
                })
            except Exception:
                pass
            await self.cancel_attended_transfer(
                transfer.id,
                publish_cancelled=False,
            )
        else:
            call.transfer_mode = None
            call.transfer_target = None

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
