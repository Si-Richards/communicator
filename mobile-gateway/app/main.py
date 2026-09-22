import asyncio
import hashlib
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect

from .apns import APNSClient
from .config import settings
from .manager import MobileSessionManager
from .models import (
    AnswerRequest,
    AttendedTransferStartRequest,
    CandidateRequest,
    DeviceRegistration,
    DiagnosticEvent,
    OutboundCallRequest,
    TransferRequest,
)
from .store import DeviceStore

store = DeviceStore(settings.database_path, settings.device_data_key)
apns = APNSClient()
manager = MobileSessionManager(store, apns)
diag_logger = logging.getLogger('uvicorn.error')


def _safe_ref(value: str | None) -> str:
    if not value:
        return '-'
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:10]


def auth(x_gateway_key: str = Header(default='')):
    if x_gateway_key != settings.gateway_api_key:
        raise HTTPException(status_code=401, detail='invalid gateway key')


@asynccontextmanager
async def lifespan(app: FastAPI):
    await manager.restore()
    yield


app = FastAPI(title='VoiceHost Mobile Gateway', version='0.1.0', lifespan=lifespan)


@app.get('/health')
async def health():
    return {
        'ok': True,
        'sessions': len(manager.sessions),
        'helpers': sum(len(items) for items in manager.helpers.values()),
        'active_calls': sum(len(items) for items in manager.device_calls.values()),
        'calls': len(manager.calls),
    }


@app.post('/v1/devices/register', dependencies=[Depends(auth)])
async def register_device(body: DeviceRegistration):
    device = store.upsert(body)
    asyncio.create_task(manager.ensure_session(device))
    return {'ok': True, 'device_id': device.device_id}


@app.post('/v1/devices/{device_id}/test-push', dependencies=[Depends(auth)])
async def test_push(device_id: str):
    try:
        device = store.get(device_id)
    except KeyError:
        raise HTTPException(404, 'device not found')
    import uuid
    call_id = str(uuid.uuid4())
    await apns.send_voip(device.push_token, {
        'aps': {'content-available': 1},
        'id': call_id,
        'nameCaller': 'VoiceHost Push Test',
        'handle': 'TEST',
        'isVideo': False,
        'extra': {'call_id': call_id, 'test': True},
    })
    return {'ok': True, 'call_id': call_id}


@app.post('/v1/devices/{device_id}/calls', dependencies=[Depends(auth)])
async def start_call(device_id: str, body: OutboundCallRequest):
    try:
        call = await manager.start_outbound_call(
            device_id,
            body.target,
            body.sdp,
        )
    except KeyError:
        raise HTTPException(404, 'device not found')
    except RuntimeError as error:
        raise HTTPException(409, str(error))
    return {'ok': True, 'call_id': call.id}


@app.get('/v1/calls/{call_id}', dependencies=[Depends(auth)])
async def get_call(call_id: str):
    try:
        call = manager.get_call(call_id)
    except KeyError:
        raise HTTPException(404, 'call not found')
    return {
        'id': call.id,
        'caller': call.caller,
        'display_name': call.display_name,
        'offer_sdp': call.offer_sdp,
        'connected': call.connected,
        'held': call.held,
        'direction': call.direction,
    }


@app.post('/v1/calls/{call_id}/answer', dependencies=[Depends(auth)])
async def answer(call_id: str, body: AnswerRequest):
    try:
        await manager.answer(call_id, body.sdp)
    except KeyError:
        raise HTTPException(404, 'call not found')
    return {'ok': True}


@app.post('/v1/calls/{call_id}/decline', dependencies=[Depends(auth)])
async def decline(call_id: str):
    try:
        await manager.decline(call_id)
    except KeyError:
        raise HTTPException(404, 'call not found')
    return {'ok': True}


@app.post('/v1/calls/{call_id}/hangup', dependencies=[Depends(auth)])
async def hangup(call_id: str):
    try:
        await manager.hangup(call_id)
    except KeyError:
        raise HTTPException(404, 'call not found')
    return {'ok': True}


@app.post('/v1/calls/{call_id}/hold', dependencies=[Depends(auth)])
async def hold(call_id: str):
    try:
        await manager.set_hold(call_id, True)
    except KeyError:
        raise HTTPException(404, 'call not found')
    except RuntimeError as error:
        raise HTTPException(409, str(error))
    return {'ok': True}


@app.post('/v1/calls/{call_id}/resume', dependencies=[Depends(auth)])
async def resume(call_id: str):
    try:
        await manager.set_hold(call_id, False)
    except KeyError:
        raise HTTPException(404, 'call not found')
    except RuntimeError as error:
        raise HTTPException(409, str(error))
    return {'ok': True}


@app.post('/v1/calls/{call_id}/candidate', dependencies=[Depends(auth)])
async def candidate(call_id: str, body: CandidateRequest):
    try:
        await manager.candidate(call_id, body.model_dump(exclude_none=True))
    except KeyError:
        raise HTTPException(404, 'call not found')
    return {'ok': True}





@app.post('/v1/calls/{call_id}/transfer/blind', dependencies=[Depends(auth)])
async def blind_transfer(call_id: str, body: TransferRequest):
    try:
        await manager.blind_transfer(call_id, body.target)
    except KeyError:
        raise HTTPException(404, 'call not found')
    except RuntimeError as error:
        raise HTTPException(409, str(error))
    return {'ok': True}


@app.post('/v1/calls/{call_id}/transfer/attended', dependencies=[Depends(auth)])
async def start_attended_transfer(call_id: str, body: AttendedTransferStartRequest):
    try:
        transfer = await manager.start_attended_transfer(
            call_id,
            body.target,
            body.sdp,
        )
    except KeyError:
        raise HTTPException(404, 'call not found')
    except RuntimeError as error:
        raise HTTPException(409, str(error))
    return {'ok': True, 'transfer_id': transfer.id}


@app.post('/v1/transfers/{transfer_id}/candidate', dependencies=[Depends(auth)])
async def transfer_candidate(transfer_id: str, body: CandidateRequest):
    try:
        await manager.attended_candidate(
            transfer_id,
            body.model_dump(exclude_none=True),
        )
    except KeyError:
        raise HTTPException(404, 'transfer not found')
    return {'ok': True}


@app.post('/v1/transfers/{transfer_id}/complete', dependencies=[Depends(auth)])
async def complete_attended_transfer(transfer_id: str):
    try:
        await manager.complete_attended_transfer(transfer_id)
    except KeyError:
        raise HTTPException(404, 'transfer not found')
    except RuntimeError as error:
        raise HTTPException(409, str(error))
    return {'ok': True}


@app.post('/v1/transfers/{transfer_id}/cancel', dependencies=[Depends(auth)])
async def cancel_attended_transfer(transfer_id: str):
    await manager.cancel_attended_transfer(transfer_id)
    return {'ok': True}


@app.websocket('/v1/transfers/{transfer_id}/events')
async def transfer_events(websocket: WebSocket, transfer_id: str):
    if websocket.headers.get('x-gateway-key', '') != settings.gateway_api_key:
        await websocket.close(code=4401)
        return
    try:
        transfer = manager.get_transfer(transfer_id)
    except KeyError:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    queue = asyncio.Queue()
    transfer.subscribers.add(queue)
    try:
        for event in transfer.buffered:
            await websocket.send_json(event)
        transfer.buffered.clear()
        while True:
            await websocket.send_json(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        transfer.subscribers.discard(queue)


@app.post('/v1/diagnostics', dependencies=[Depends(auth)])
async def diagnostics(body: DiagnosticEvent):
    # Intentionally log only bounded, structured diagnostic data. Never send
    # or log tokens, credentials, SDP, ICE candidate strings or caller data.
    safe_details = {
        key: value
        for key, value in body.details.items()
        if key in {
            'ice_state', 'peer_state', 'local_candidates', 'remote_candidates',
            'local_audio_tracks', 'remote_audio_tracks', 'sdp_length',
            'app_state', 'callkit_audio', 'gateway_event',
        }
    }
    diag_logger.info(
        '[VH-DIAG] event=%s call=%s details=%s',
        body.event,
        _safe_ref(body.call_id),
        safe_details,
    )
    return {'ok': True}


@app.websocket('/v1/calls/{call_id}/events')
async def call_events(websocket: WebSocket, call_id: str):
    if websocket.headers.get('x-gateway-key', '') != settings.gateway_api_key:
        await websocket.close(code=4401)
        return
    try:
        call = manager.get_call(call_id)
    except KeyError:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    queue = asyncio.Queue()
    call.subscribers.add(queue)
    try:
        for event in call.buffered:
            await websocket.send_json(event)
        call.buffered.clear()
        while True:
            await websocket.send_json(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        call.subscribers.discard(queue)
