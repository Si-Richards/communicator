import asyncio
import hashlib
import logging
import re
import uuid
from dataclasses import dataclass, field

from .apns import APNSClient, APNSError
from .janus import JanusSipSession
from .config import settings
from .models import DeviceRecord

logger = logging.getLogger('uvicorn.error')


def _safe_ref(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:10]


def _candidate_metadata(candidate: dict) -> dict:
    value = str(candidate.get('candidate') or '').strip()
    if not value:
        return {}
    parts = value.split()
    if len(parts) < 8:
        return {}
    try:
        typ_index = parts.index('typ')
    except ValueError:
        return {}
    result = {
        'candidate_type': parts[typ_index + 1] if typ_index + 1 < len(parts) else 'unknown',
    }
    if len(parts) > 5:
        result['ip'] = parts[4]
        try:
            result['port'] = int(parts[5])
        except (TypeError, ValueError):
            pass
    return result


@dataclass
class CallRuntime:
    id: str
    device_id: str
    caller: str
    display_name: str | None
    offer_sdp: str
    session: JanusSipSession | None = field(default=None, repr=False)
    sip_call_id: str | None = None
    direction: str = 'incoming'
    connected: bool = False
    held: bool = False
    local_ending: bool = False
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
        self.helpers: dict[str, list[JanusSipSession]] = {}
        self.calls: dict[str, CallRuntime] = {}
        self.session_call: dict[int, str] = {}
        self.device_calls: dict[str, set[str]] = {}
        self.transfers: dict[str, TransferRuntime] = {}
        self.device_transfer: dict[str, str] = {}
        self.voicemail: dict[str, dict[str, int | bool]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def restore(self):
        for device in self.store.all():
            asyncio.create_task(self.ensure_session(device))

    async def ensure_session(self, device: DeviceRecord):
        lock = self._locks.setdefault(device.device_id, asyncio.Lock())
        async with lock:
            existing = self.sessions.get(device.device_id)
            if (
                existing
                and self._same_sip_registration(existing.device, device)
                and self._session_alive(existing)
            ):
                existing.device = device
                for helper in self.helpers.get(device.device_id, []):
                    helper.device = device
                await self._ensure_helpers(device, existing)
                logger.info(
                    '[VH-DIAG] event=session_reused device=%s helpers=%s',
                    _safe_ref(device.device_id),
                    len(self.helpers.get(device.device_id, [])),
                )
                return

            await self._stop_device_sessions(device.device_id)

            master = await self._create_session(device)
            self.sessions[device.device_id] = master
            try:
                await master.subscribe_message_summary()
                logger.info(
                    '[VH-DIAG] event=voicemail_subscribed device=%s',
                    _safe_ref(device.device_id),
                )
            except Exception:
                logger.exception(
                    '[VH-DIAG] event=voicemail_subscribe_failed device=%s',
                    _safe_ref(device.device_id),
                )
            logger.info(
                '[VH-DIAG] event=session_start device=%s master_id=%s peer=%s session=%s handle=%s',
                _safe_ref(device.device_id),
                master.master_id,
                master.peer_ip or '-',
                master.session_id or '-',
                master.handle_id or '-',
            )
            await self._ensure_helpers(device, master)

    @staticmethod
    def _session_alive(session: JanusSipSession) -> bool:
        reader = getattr(session, '_reader_task', None)
        return reader is not None and not reader.done()

    async def _create_session(
        self,
        device: DeviceRecord,
        helper_master_id: int | None = None,
    ) -> JanusSipSession:
        session: JanusSipSession | None = None

        async def plugin(data, jsep):
            assert session is not None
            await self._plugin_event(session.device, session, data, jsep)

        async def trickle(candidate):
            assert session is not None
            call = self._call_for_session(session)
            if call:
                meta = _candidate_metadata(candidate)
                logger.info(
                    '[VH-DIAG] event=janus_candidate call=%s completed=%s type=%s media=%s:%s',
                    _safe_ref(call.id),
                    bool(candidate.get('completed')),
                    meta.get('candidate_type', '-'),
                    meta.get('ip', '-'),
                    meta.get('port', '-'),
                )
                if meta:
                    self.store.update_call(
                        call.id,
                        janus_candidate_type=meta.get('candidate_type'),
                        janus_media_ip=meta.get('ip'),
                        janus_media_port=meta.get('port'),
                    )
                    self.store.add_call_event(call.id, 'janus_candidate', {
                        'candidate_type': meta.get('candidate_type', ''),
                        'janus_media_ip': meta.get('ip', ''),
                        'janus_media_port': meta.get('port', 0),
                    })
                await call.publish({'type': 'trickle', 'candidate': candidate})

        session = JanusSipSession(
            device,
            plugin,
            trickle,
            helper_master_id=helper_master_id,
        )
        await session.start()
        await session.wait_registered()
        if helper_master_id is None:
            try:
                await session.subscribe_message_summary()
                logger.info(
                    '[VH-DIAG] event=mwi_subscribe device=%s',
                    _safe_ref(device.device_id),
                )
            except Exception:
                logger.exception(
                    '[VH-DIAG] event=mwi_subscribe_failed device=%s',
                    _safe_ref(device.device_id),
                )
        return session

    async def _ensure_helpers(
        self,
        device: DeviceRecord,
        master: JanusSipSession,
    ):
        if master.master_id is None:
            await master.wait_registered()
        if master.master_id is None:
            raise RuntimeError('Janus SIP master session has no master_id')

        helpers = [
            helper
            for helper in self.helpers.get(device.device_id, [])
            if self._session_alive(helper)
        ]
        self.helpers[device.device_id] = helpers

        wanted = max(0, settings.janus_helper_count)
        while len(helpers) < wanted:
            helper = await self._create_session(
                device,
                helper_master_id=master.master_id,
            )
            helpers.append(helper)
            logger.info(
                '[VH-DIAG] event=helper_ready device=%s helper=%s total=%s',
                _safe_ref(device.device_id),
                helper.handle_id,
                len(helpers),
            )

    async def _stop_device_sessions(self, device_id: str):
        for helper in self.helpers.pop(device_id, []):
            try:
                await helper.stop()
            except Exception:
                pass
            self.session_call.pop(id(helper), None)

        master = self.sessions.pop(device_id, None)
        if master:
            try:
                await master.stop()
            except Exception:
                pass
            self.session_call.pop(id(master), None)

        for call_id in list(self.device_calls.pop(device_id, set())):
            call = self.calls.get(call_id)
            if call:
                call.session = None

    async def remove_device(self, device_id: str):
        lock = self._locks.setdefault(device_id, asyncio.Lock())
        async with lock:
            transfer_id = self.device_transfer.pop(device_id, None)
            if transfer_id:
                transfer = self.transfers.pop(transfer_id, None)
                if transfer:
                    try:
                        await transfer.helper.stop()
                    except Exception:
                        pass

            await self._stop_device_sessions(device_id)
            self._locks.pop(device_id, None)
            logger.info(
                '[VH-DIAG] event=device_removed device=%s',
                _safe_ref(device_id),
            )

    def _call_for_session(self, session: JanusSipSession):
        call_id = self.session_call.get(id(session))
        return self.calls.get(call_id) if call_id else None

    def _bind_call_session(
        self,
        call: CallRuntime,
        session: JanusSipSession,
    ):
        call.session = session
        self.session_call[id(session)] = call.id
        self.device_calls.setdefault(call.device_id, set()).add(call.id)
        self.store.begin_call(
            call.id,
            call.device_id,
            call.direction,
            janus_peer_ip=session.peer_ip,
            janus_peer_port=session.peer_port,
            janus_session_id=session.session_id,
            janus_handle_id=session.handle_id,
            sip_call_id=call.sip_call_id,
        )

    def _release_call_session(self, call: CallRuntime):
        session = call.session
        if session:
            self.session_call.pop(id(session), None)
        call.session = None
        calls = self.device_calls.get(call.device_id)
        if calls:
            calls.discard(call.id)
            if not calls:
                self.device_calls.pop(call.device_id, None)

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
        plugin_error = data.get('error')
        if plugin_error:
            call = self._call_for_session(session)
            if call and call.transfer_mode:
                logger.warning(
                    '[VH-DIAG] event=transfer_plugin_error call=%s',
                    _safe_ref(call.id),
                )
                await call.publish({
                    'type': 'transfer',
                    'state': 'failed',
                    'reason': 'janus_plugin_error',
                })
                call.transfer_mode = None
                call.transfer_target = None
            return

        if event == 'notify':
            notify_type = str(result.get('notify') or '').lower()
            if notify_type == 'message-summary':
                summary = self._parse_message_summary(
                    str(result.get('content') or '')
                )
                self.voicemail[device.device_id] = summary
                logger.info(
                    '[VH-DIAG] event=mwi_update device=%s waiting=%s new=%s old=%s',
                    _safe_ref(device.device_id),
                    summary['waiting'],
                    summary['new_messages'],
                    summary['old_messages'],
                )
                return

        if event == 'incomingcall':
            if device.dnd:
                await session.decline(486)
                return
            caller_uri = str(result.get('username') or 'Unknown')
            caller = caller_uri.replace('sip:', '').split('@', 1)[0]
            display = result.get('displayname')
            offer = (jsep or {}).get('sdp') or ''
            is_video = bool(re.search(r'(?m)^m=video\s+\d+', offer))
            call_id = str(uuid.uuid4())
            call = CallRuntime(
                call_id,
                device.device_id,
                caller,
                display,
                offer,
                session=session,
                sip_call_id=data.get('call_id'),
            )
            self.calls[call_id] = call
            self._bind_call_session(call, session)
            logger.info(
                '[VH-DIAG] event=incoming_call call=%s device=%s offer_sdp=%s video=%s',
                _safe_ref(call_id),
                _safe_ref(device.device_id),
                bool(offer),
                is_video,
            )
            if not self.store.is_push_token_valid(
                device.device_id,
                device.push_token,
            ):
                logger.warning(
                    '[VH-DIAG] event=incoming_push_skipped_invalid_token '
                    'call=%s device=%s',
                    _safe_ref(call_id),
                    _safe_ref(device.device_id),
                )
                try:
                    await session.decline(480)
                except Exception:
                    logger.exception(
                        '[VH-DIAG] event=incoming_push_decline_failed call=%s',
                        _safe_ref(call_id),
                    )
                self._release_call_session(call)
                return

            try:
                environment = await self.apns.send_voip(device.push_token, {
                    'aps': {'content-available': 1},
                    'id': call_id,
                    'nameCaller': display or caller,
                    'handle': caller,
                    'isVideo': is_video,
                    'extra': {'call_id': call_id, 'is_video': is_video},
                })
                logger.info(
                    '[VH-DIAG] event=incoming_push_sent call=%s environment=%s',
                    _safe_ref(call_id),
                    environment,
                )
            except APNSError as error:
                if error.reason in {
                    'Unregistered',
                    'BadDeviceToken',
                    'DeviceTokenNotForTopic',
                }:
                    invalidated = self.store.invalidate_push_token(
                        device.device_id,
                        device.push_token,
                        error.reason,
                    )
                    logger.warning(
                        '[VH-DIAG] event=push_token_invalidated '
                        'device=%s reason=%s changed=%s',
                        _safe_ref(device.device_id),
                        error.reason,
                        invalidated,
                    )
                logger.error(
                    '[VH-DIAG] event=incoming_push_failed call=%s reason=%s',
                    _safe_ref(call_id),
                    str(error),
                )
                try:
                    await session.decline(480)
                except Exception:
                    logger.exception(
                        '[VH-DIAG] event=incoming_push_decline_failed call=%s',
                        _safe_ref(call_id),
                    )
                self._release_call_session(call)
            except Exception as error:
                logger.error(
                    '[VH-DIAG] event=incoming_push_failed call=%s reason=%s',
                    _safe_ref(call_id),
                    str(error),
                )
                try:
                    await session.decline(480)
                except Exception:
                    logger.exception(
                        '[VH-DIAG] event=incoming_push_decline_failed call=%s',
                        _safe_ref(call_id),
                    )
                self._release_call_session(call)
            return

        if event == 'notify' and str(result.get('notify') or '').lower() == 'message-summary':
            content = str(result.get('content') or '')
            summary = self._parse_message_summary(content)
            self.voicemail[device.device_id] = summary
            logger.info(
                '[VH-DIAG] event=voicemail_update device=%s waiting=%s new=%s old=%s',
                _safe_ref(device.device_id),
                summary['waiting'],
                summary['new_messages'],
                summary['old_messages'],
            )
            return

        call = self._call_for_session(session)
        if not call:
            return

        sip_call_id = data.get('call_id')
        if sip_call_id:
            call.sip_call_id = str(sip_call_id)
            self.store.update_call(call.id, sip_call_id=call.sip_call_id)

        if event == 'transferring':
            await call.publish({'type': 'transfer', 'state': 'transferring'})
            transfer = self._current_transfer(device.device_id)
            if transfer:
                await transfer.publish({'type': 'transfer', 'state': 'transferring'})
            return

        if event == 'transfer_failed':
            status = result.get('code')
            logger.warning(
                '[VH-DIAG] event=transfer_failed call=%s status=%s',
                _safe_ref(call.id),
                status,
            )
            await call.publish({
                'type': 'transfer',
                'state': 'failed',
                'status': status,
            })
            transfer = self._current_transfer(device.device_id)
            if transfer:
                await transfer.publish({
                    'type': 'transfer',
                    'state': 'failed',
                    'status': status,
                })
            call.transfer_mode = None
            call.transfer_target = None
            return

        if event == 'notify' and call.transfer_mode:
            status = self._refer_status(result.get('content'))
            logger.info(
                '[VH-DIAG] event=transfer_notify call=%s status=%s substate=%s',
                _safe_ref(call.id),
                status,
                result.get('substate'),
            )
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

        if event in {'ringing', 'progress', 'accepted', 'updated', 'updatingcall'}:
            if event == 'accepted':
                call.connected = True
                call.held = False
                self.store.mark_call_connected(call.id)
            logger.info(
                '[VH-DIAG] event=janus_%s call=%s jsep=%s',
                event,
                _safe_ref(call.id),
                bool(jsep),
            )
            await call.publish({'type': event, 'jsep': jsep, 'result': result})
        elif event == 'holding':
            call.held = True
            await call.publish({'type': 'hold', 'held': True})
        elif event == 'resuming':
            call.held = False
            await call.publish({'type': 'hold', 'held': False})
        elif event == 'hangup':
            self.store.end_call(
                call.id,
                status='ended' if call.connected else 'failed',
                details={
                    'code': result.get('code') or 0,
                    'reason_header_cause': result.get('reason_header_cause') or 0,
                },
            )
            await call.publish({
                'type': 'hangup',
                'reason': result.get('reason'),
                'code': result.get('code'),
                'reason_header_cause': result.get('reason_header_cause'),
            })

            # If an unanswered fork disappears because another endpoint answered
            # (or the caller cancelled), dismiss native CallKit even when Dart is
            # suspended and therefore has no websocket subscriber.
            if (
                call.direction == 'incoming'
                and not call.connected
                and not call.local_ending
            ):
                logger.info(
                    '[VH-DIAG] event=remote_ringing_end call=%s code=%s cause=%s',
                    _safe_ref(call.id),
                    result.get('code'),
                    result.get('reason_header_cause'),
                )
                try:
                    await self.apns.send_voip(device.push_token, {
                        'aps': {'content-available': 1},
                        'action': 'end',
                        'id': call.id,
                        'extra': {
                            'call_id': call.id,
                            'reason': 'remote_ringing_end',
                        },
                    })
                except Exception:
                    logger.exception(
                        '[VH-DIAG] event=callkit_end_push_failed call=%s',
                        _safe_ref(call.id),
                    )

            self._release_call_session(call)
            transfer = self._current_transfer(device.device_id)
            if transfer and not transfer.closing:
                asyncio.create_task(
                    self.cancel_attended_transfer(transfer.id, restore_original=False)
                )

    def _current_transfer(self, device_id: str):
        transfer_id = self.device_transfer.get(device_id)
        return self.transfers.get(transfer_id) if transfer_id else None

    def get_voicemail(self, device_id: str) -> dict[str, int | bool]:
        if device_id not in self.sessions and device_id not in self.voicemail:
            self.store.get(device_id)
        return self.voicemail.get(
            device_id,
            {'waiting': False, 'new_messages': 0, 'old_messages': 0},
        )

    @staticmethod
    def _parse_message_summary(content: str) -> dict[str, int | bool]:
        waiting = False
        new_messages = 0
        old_messages = 0
        for raw_line in content.splitlines():
            line = raw_line.strip()
            lower = line.lower()
            if lower.startswith('messages-waiting:'):
                waiting = lower.split(':', 1)[1].strip() == 'yes'
            match = re.match(
                r'^voice-message:\s*(\d+)\s*/\s*(\d+)',
                line,
                flags=re.IGNORECASE,
            )
            if match:
                new_messages = int(match.group(1))
                old_messages = int(match.group(2))
        return {
            'waiting': waiting or new_messages > 0,
            'new_messages': new_messages,
            'old_messages': old_messages,
        }

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

    @staticmethod
    def _transfer_user(device: DeviceRecord, target: str) -> str:
        value = target.strip()
        if '*' in value:
            return value

        # VoiceHost hosted-PBX usernames are tenant*extension. A plain short
        # transfer destination therefore needs the tenant prefix from the
        # authenticated SIP account, e.g. 10000*213 -> transfer 207 as 10000*207.
        account = device.sip_username.strip()
        if '*' in account and re.fullmatch(r'\d{1,6}', value):
            tenant = account.split('*', 1)[0]
            if tenant:
                return f'{tenant}*{value}'
        return value

    @classmethod
    def _transfer_uri(cls, device: DeviceRecord, target: str) -> str:
        value = target.strip()
        if value.startswith('sip:') or value.startswith('sips:'):
            return value
        return f'sip:{cls._transfer_user(device, value)}@{device.sip_realm}'

    def _idle_session(self, device_id: str):
        candidates = []
        master = self.sessions.get(device_id)
        if master:
            candidates.append(master)
        candidates.extend(self.helpers.get(device_id, []))
        for session in candidates:
            if self._session_alive(session) and id(session) not in self.session_call:
                return session
        return None

    async def start_outbound_call(
        self,
        device_id: str,
        target: str,
        offer_sdp: str,
    ) -> CallRuntime:
        device = self.store.get(device_id)
        if device_id not in self.sessions:
            await self.ensure_session(device)

        session = self._idle_session(device_id)
        if session is None:
            raise RuntimeError('No free SIP call slot is available')

        call_id = str(uuid.uuid4())
        call = CallRuntime(
            id=call_id,
            device_id=device_id,
            caller=target.strip(),
            display_name=None,
            offer_sdp='',
            session=session,
            direction='outgoing',
        )
        self.calls[call_id] = call
        self._bind_call_session(call, session)

        try:
            await session.call(
                self._target_uri(device, target),
                offer_sdp,
            )
        except Exception:
            self._release_call_session(call)
            self.calls.pop(call_id, None)
            raise

        logger.info(
            '[VH-DIAG] event=outbound_call_started call=%s device=%s',
            _safe_ref(call_id),
            _safe_ref(device_id),
        )
        return call

    async def update_call_media(
        self,
        call_id: str,
        sdp: str,
        jsep_type: str,
    ):
        call = self.get_call(call_id)
        session = self._session_for_call(call_id)
        if not call.connected:
            raise RuntimeError('Call is not connected')
        logger.info(
            '[VH-DIAG] event=media_update_requested call=%s type=%s video=%s',
            _safe_ref(call_id),
            jsep_type,
            bool(re.search(r'(?m)^m=video\s+\d+', sdp)),
        )
        await session.update(sdp, jsep_type)

    async def blind_transfer(self, call_id: str, target: str):
        call = self.get_call(call_id)
        if call.transfer_mode:
            raise RuntimeError('A transfer is already in progress')
        session = self._session_for_call(call_id)
        uri = self._transfer_uri(session.device, target)
        call.transfer_mode = 'blind'
        call.transfer_target = target
        logger.info(
            '[VH-DIAG] event=blind_transfer_requested call=%s',
            _safe_ref(call_id),
        )
        await session.transfer(uri)
        asyncio.create_task(self._transfer_watchdog(call.id, 'blind'))

    async def _transfer_watchdog(self, call_id: str, mode: str):
        await asyncio.sleep(20)
        call = self.calls.get(call_id)
        if not call or call.transfer_mode != mode:
            return
        logger.warning(
            '[VH-DIAG] event=transfer_timeout call=%s mode=%s',
            _safe_ref(call_id),
            mode,
        )
        await call.publish({
            'type': 'transfer',
            'state': 'failed',
            'reason': 'timeout',
        })
        call.transfer_mode = None
        call.transfer_target = None

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
                self._transfer_uri(master.device, target),
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
            self._transfer_uri(master.device, transfer.target),
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
        session = call.session
        if not session or not self._session_alive(session):
            raise RuntimeError('Call Janus session is unavailable')
        return session

    async def set_hold(self, call_id: str, held: bool):
        call = self.get_call(call_id)
        session = self._session_for_call(call_id)
        if call.held == held:
            return
        if held:
            await session.hold()
        else:
            await session.unhold()
        call.held = held
        logger.info(
            '[VH-DIAG] event=call_hold call=%s held=%s',
            _safe_ref(call_id),
            held,
        )
        await call.publish({'type': 'hold', 'held': held})

    async def answer(self, call_id: str, sdp: str):
        logger.info(
            '[VH-DIAG] event=answer_received call=%s sdp_length=%s',
            _safe_ref(call_id),
            len(sdp),
        )
        await self._session_for_call(call_id).accept(sdp)

    async def decline(self, call_id: str):
        call = self.get_call(call_id)
        call.local_ending = True
        await self._session_for_call(call_id).decline(486)

    async def hangup(self, call_id: str):
        call = self.get_call(call_id)
        call.local_ending = True
        await self._session_for_call(call_id).hangup()

    async def candidate(self, call_id: str, candidate: dict):
        logger.info(
            '[VH-DIAG] event=handset_candidate call=%s completed=%s',
            _safe_ref(call_id),
            bool(candidate.get('completed')),
        )
        await self._session_for_call(call_id).trickle(candidate)

    async def dtmf(self, call_id: str, digit: str, duration: int = 160):
        call = self.get_call(call_id)
        if not call.connected:
            raise RuntimeError('Call is not connected')
        await self._session_for_call(call_id).dtmf(digit, duration)
        logger.info(
            '[VH-DIAG] event=dtmf_sent call=%s digit=%s',
            _safe_ref(call_id),
            digit,
        )
