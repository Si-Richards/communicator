import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect

from .apns import APNSClient
from .config import settings
from .manager import MobileSessionManager
from .models import AnswerRequest, CandidateRequest, DeviceRegistration
from .store import DeviceStore

store = DeviceStore(settings.database_path, settings.device_data_key)
apns = APNSClient()
manager = MobileSessionManager(store, apns)


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
    return {'ok': True, 'sessions': len(manager.sessions), 'calls': len(manager.calls)}


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


@app.post('/v1/calls/{call_id}/candidate', dependencies=[Depends(auth)])
async def candidate(call_id: str, body: CandidateRequest):
    try:
        await manager.candidate(call_id, body.model_dump(exclude_none=True))
    except KeyError:
        raise HTTPException(404, 'call not found')
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
