import asyncio
import hashlib
import html
import json
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

from .apns import APNSClient
from .config import settings
from .manager import MobileSessionManager
from .models import (
    AnswerRequest,
    AttendedTransferStartRequest,
    CandidateRequest,
    DeviceRegistration,
    DtmfRequest,
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


def admin_action(x_admin_action: str = Header(default='')):
    if x_admin_action != '1':
        raise HTTPException(status_code=403, detail='admin action header required')


async def _send_test_push(device_id: str) -> str:
    try:
        device = store.get(device_id)
    except KeyError:
        raise HTTPException(404, 'device not found')

    import uuid
    call_id = str(uuid.uuid4())
    try:
        environment = await apns.send_voip(device.push_token, {
            'aps': {'content-available': 1},
            'id': call_id,
            'nameCaller': 'VoiceHost Push Test',
            'handle': 'TEST',
            'isVideo': False,
            'extra': {'call_id': call_id, 'test': True},
        })
    except RuntimeError as error:
        diag_logger.warning(
            '[VH-DIAG] event=test_push_failed device=%s reason=%s',
            _safe_ref(device_id),
            str(error),
        )
        raise HTTPException(status_code=502, detail=str(error)) from error

    diag_logger.info(
        '[VH-DIAG] event=test_push_sent device=%s environment=%s',
        _safe_ref(device_id),
        environment,
    )
    return environment


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
        'apns_configured': apns.configured,
        'apns_primary_environment': (
            'sandbox' if settings.apns_sandbox else 'production'
        ),
        'apns_fallback_environment': settings.apns_fallback_environment,
    }


@app.get('/admin', response_class=HTMLResponse)
async def admin_devices(request: Request):
    devices = store.admin_list()
    rows = []
    for item in devices:
        device_id = item['device_id']
        session = manager.sessions.get(device_id)
        session_online = bool(session and manager._session_alive(session))
        helper_count = len(manager.helpers.get(device_id, []))
        active_calls = len(manager.device_calls.get(device_id, set()))
        nickname = item['nickname'] or '—'
        dnd = 'On' if item['dnd'] else 'Off'
        status_class = 'ok' if session_online else 'bad'
        status_text = 'Online' if session_online else 'Offline'

        safe_nickname = html.escape(nickname)
        safe_username = html.escape(item['sip_username'])
        safe_platform = html.escape(item['platform'])
        safe_updated = html.escape(item['updated_at'])
        js_device_id = html.escape(json.dumps(device_id), quote=True)
        js_nickname = html.escape(json.dumps(nickname), quote=True)

        rows.append(f"""
          <tr>
            <td><strong>{safe_nickname}</strong><div class="muted">{safe_username}</div></td>
            <td>{safe_platform}</td>
            <td><span class="status {status_class}">{status_text}</span></td>
            <td>{helper_count}</td>
            <td>{active_calls}</td>
            <td>{dnd}</td>
            <td><span class="muted">{safe_updated}</span></td>
            <td>
              <div class="actions">
                <button class="secondary" onclick="testPush({js_device_id}, this)">Test push</button>
                <button class="danger" {'disabled title="Cannot delete while calls are active"' if active_calls else ''} onclick="deleteDevice({js_device_id}, {js_nickname})">Delete</button>
              </div>
            </td>
          </tr>
        """)

    table_rows = ''.join(rows) or """
      <tr><td colspan="8" class="empty">No devices are currently provisioned.</td></tr>
    """

    return HTMLResponse(f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Randy Devices · VoiceHost</title>
  <style>
    :root {{
      color-scheme: light;
      --orange:#ff6600;
      --navy:#113b53;
      --bg:#f6f7f9;
      --card:#ffffff;
      --border:#e5e7eb;
      --muted:#6b7280;
      --danger:#b42318;
      --success:#157347;
    }}
    * {{ box-sizing:border-box; }}
    body {{
      margin:0; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      background:var(--bg); color:#17212b;
    }}
    header {{
      background:var(--navy); color:white; padding:18px 28px;
      display:flex; align-items:center; justify-content:space-between; gap:20px;
    }}
    header h1 {{ margin:0; font-size:20px; font-weight:700; }}
    header .badge {{ background:var(--orange); color:white; padding:6px 10px; border-radius:999px; font-size:12px; }}
    main {{ max-width:1400px; margin:28px auto; padding:0 20px; }}
    .summary {{ display:flex; gap:12px; margin-bottom:18px; flex-wrap:wrap; }}
    .metric {{
      background:var(--card); border:1px solid var(--border); border-radius:12px; padding:14px 16px; min-width:150px;
      box-shadow:0 1px 2px rgba(0,0,0,.03);
    }}
    .metric strong {{ display:block; font-size:24px; color:var(--navy); }}
    .metric span {{ color:var(--muted); font-size:13px; }}
    .panel {{
      background:var(--card); border:1px solid var(--border); border-radius:14px; overflow:hidden;
      box-shadow:0 1px 3px rgba(0,0,0,.04);
    }}
    .panel-head {{ padding:16px 18px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); }}
    .panel-head h2 {{ margin:0; font-size:17px; }}
    .panel-head button {{ background:var(--orange); color:white; }}
    .table-wrap {{ overflow-x:auto; }}
    table {{ width:100%; border-collapse:collapse; min-width:980px; }}
    th, td {{ text-align:left; padding:13px 14px; border-bottom:1px solid var(--border); vertical-align:middle; }}
    th {{ background:#fafafa; color:#475467; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }}
    tbody tr:last-child td {{ border-bottom:0; }}
    .muted {{ color:var(--muted); font-size:12px; margin-top:3px; }}
    .status {{ display:inline-block; padding:4px 8px; border-radius:999px; font-size:12px; font-weight:700; }}
    .status.ok {{ color:var(--success); background:#e8f5ee; }}
    .status.bad {{ color:#8a1c13; background:#fdecea; }}
    .actions {{ display:flex; gap:8px; white-space:nowrap; }}
    button {{
      border:0; border-radius:8px; padding:8px 11px; cursor:pointer; font-weight:650;
    }}
    button:disabled {{ opacity:.55; cursor:wait; }}
    button.secondary {{ background:#eef2f5; color:var(--navy); }}
    button.danger {{ background:#fff0ee; color:var(--danger); }}
    .empty {{ text-align:center; color:var(--muted); padding:36px; }}
    #toast {{
      position:fixed; right:18px; bottom:18px; max-width:440px; background:var(--navy); color:white;
      padding:12px 14px; border-radius:10px; box-shadow:0 8px 30px rgba(0,0,0,.18);
      display:none;
    }}
    @media (max-width:700px) {{ header {{ padding:16px 18px; }} main {{ margin-top:18px; }} }}
  </style>
</head>
<body>
<header>
  <h1>VoiceHost · Randy Device Manager</h1>
  <div class="header-actions">
    <a class="admin-link" href="/admin/calls">Calls / Media</a>
    <span class="badge">Restricted admin</span>
  </div>
</header>
<main>
  <div class="summary">
    <div class="metric"><strong>{len(devices)}</strong><span>Provisioned devices</span></div>
    <div class="metric"><strong>{len(manager.sessions)}</strong><span>Master sessions</span></div>
    <div class="metric"><strong>{sum(len(v) for v in manager.helpers.values())}</strong><span>Helper sessions</span></div>
    <div class="metric"><strong>{sum(len(v) for v in manager.device_calls.values())}</strong><span>Active calls</span></div>
  </div>
  <section class="panel">
    <div class="panel-head">
      <h2>Devices</h2>
      <button onclick="location.reload()">Refresh</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Device</th><th>Platform</th><th>Session</th><th>Helpers</th>
            <th>Calls</th><th>DND</th><th>Last updated</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>{table_rows}</tbody>
      </table>
    </div>
  </section>
</main>
<div id="toast"></div>
<script>
  function toast(message, error=false) {{
    const el = document.getElementById('toast');
    el.textContent = message;
    el.style.background = error ? '#8a1c13' : '#113b53';
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 4200);
  }}

  async function adminPost(url) {{
    const response = await fetch(url, {{
      method:'POST',
      credentials:'same-origin',
      headers:{{'X-Admin-Action':'1'}}
    }});
    let data = {{}};
    try {{ data = await response.json(); }} catch (_) {{}}
    if (!response.ok) throw new Error(data.detail || ('HTTP ' + response.status));
    return data;
  }}

  async function testPush(deviceId, button) {{
    button.disabled = true;
    try {{
      const data = await adminPost('/admin/devices/' + encodeURIComponent(deviceId) + '/test-push');
      toast('Test push sent via ' + (data.environment || 'APNs'));
    }} catch (error) {{
      toast('Test push failed: ' + error.message, true);
    }} finally {{
      button.disabled = false;
    }}
  }}

  async function deleteDevice(deviceId, label) {{
    if (!confirm('Delete ' + label + '? This removes the device and stops its Randy SIP sessions.')) return;
    try {{
      await adminPost('/admin/devices/' + encodeURIComponent(deviceId) + '/delete');
      toast('Device deleted');
      setTimeout(() => location.reload(), 500);
    }} catch (error) {{
      toast('Delete failed: ' + error.message, true);
    }}
  }}
</script>
</body>
</html>""")


@app.get('/admin/calls', response_class=HTMLResponse)
async def admin_calls(request: Request):
    params = request.query_params
    selected_node = (params.get('janus') or '').strip()
    selected_ice = (params.get('ice') or '').strip()
    failed_only = (params.get('failed') or '') == '1'
    calls = store.admin_calls(
        limit=250,
        janus_peer_ip=selected_node or None,
        ice_state=selected_ice or None,
        failed_only=failed_only,
    )
    nodes = store.janus_nodes()

    node_options = ['<option value="">All Janus nodes</option>']
    for node in nodes:
        selected = ' selected' if node == selected_node else ''
        safe_node = html.escape(node, quote=True)
        node_options.append(
            f'<option value="{safe_node}"{selected}>{safe_node}</option>'
        )

    rows = []
    for item in calls:
        call_id = item['call_id']
        call_ref = _safe_ref(call_id)
        nickname = item.get('nickname') or item.get('sip_username') or 'Unknown device'
        peer = item.get('janus_peer_ip') or '—'
        peer_port = item.get('janus_peer_port')
        peer_text = f'{peer}:{peer_port}' if peer_port else peer
        media_ip = item.get('janus_media_ip') or '—'
        media_port = item.get('janus_media_port')
        media_text = f'{media_ip}:{media_port}' if media_port else media_ip
        ice_state = item.get('ice_state') or '—'
        media_status = item.get('media_status') or 'unknown'
        status_class = (
            'ok' if media_status == 'connected'
            else 'bad' if media_status in {'failed', 'disconnected'}
            else 'neutral'
        )
        rows.append(f"""
          <tr>
            <td><strong>{html.escape(item.get('started_at') or '—')}</strong>
                <div class="muted">{html.escape(item.get('direction') or '—')}</div></td>
            <td>{html.escape(str(nickname))}<div class="muted">{call_ref}</div></td>
            <td><strong>{html.escape(peer_text)}</strong>
                <div class="muted">session {html.escape(str(item.get('janus_session_id') or '—'))}
                · handle {html.escape(str(item.get('janus_handle_id') or '—'))}</div></td>
            <td>{html.escape(media_text)}
                <div class="muted">{html.escape(item.get('janus_candidate_type') or '—')}</div></td>
            <td><span class="status {status_class}">{html.escape(media_status)}</span>
                <div class="muted">{html.escape(ice_state)}</div></td>
            <td>{html.escape(item.get('call_status') or '—')}</td>
            <td><a class="detail-link" href="/admin/calls/{html.escape(call_id, quote=True)}">View timeline</a></td>
          </tr>
        """)

    table_rows = ''.join(rows) or """
      <tr><td colspan="7" class="empty">No calls match the selected filters.</td></tr>
    """
    failed_checked = ' checked' if failed_only else ''
    ice_value = html.escape(selected_ice, quote=True)

    return HTMLResponse(f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Randy Calls · VoiceHost</title>
  <style>
    :root {{ color-scheme:light; --orange:#ff6600; --navy:#113b53; --bg:#f6f7f9;
      --card:#fff; --border:#e5e7eb; --muted:#6b7280; --danger:#b42318; --success:#157347; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      background:var(--bg); color:#17212b; }}
    header {{ background:var(--navy); color:white; padding:18px 28px; display:flex; align-items:center;
      justify-content:space-between; gap:20px; }}
    header h1 {{ margin:0; font-size:20px; }}
    header a {{ color:white; text-decoration:none; background:rgba(255,255,255,.14); padding:7px 10px;
      border-radius:8px; font-size:13px; font-weight:650; }}
    main {{ max-width:1500px; margin:28px auto; padding:0 20px; }}
    .filters {{ display:flex; flex-wrap:wrap; gap:10px; align-items:end; background:var(--card);
      border:1px solid var(--border); border-radius:12px; padding:14px; margin-bottom:16px; }}
    label {{ display:flex; flex-direction:column; gap:5px; color:var(--muted); font-size:12px; }}
    .check {{ flex-direction:row; align-items:center; padding-bottom:8px; }}
    select,input[type=text] {{ min-width:190px; border:1px solid var(--border); border-radius:8px; padding:9px 10px; background:white; }}
    button {{ border:0; border-radius:8px; padding:9px 13px; cursor:pointer; font-weight:700; background:var(--orange); color:white; }}
    .panel {{ background:var(--card); border:1px solid var(--border); border-radius:14px; overflow:hidden; }}
    .panel-head {{ padding:16px 18px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; }}
    .panel-head h2 {{ margin:0; font-size:17px; }}
    .table-wrap {{ overflow-x:auto; }}
    table {{ width:100%; border-collapse:collapse; min-width:1120px; }}
    th,td {{ text-align:left; padding:12px 14px; border-bottom:1px solid var(--border); vertical-align:top; }}
    th {{ background:#fafafa; color:#475467; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }}
    .muted {{ color:var(--muted); font-size:12px; margin-top:3px; }}
    .status {{ display:inline-block; padding:4px 8px; border-radius:999px; font-size:12px; font-weight:700; }}
    .status.ok {{ color:var(--success); background:#e8f5ee; }}
    .status.bad {{ color:#8a1c13; background:#fdecea; }}
    .status.neutral {{ color:#475467; background:#eef2f5; }}
    .detail-link {{ color:var(--navy); font-weight:700; text-decoration:none; }}
    .empty {{ text-align:center; color:var(--muted); padding:36px; }}
  </style>
</head>
<body>
<header>
  <h1>VoiceHost · Randy Calls / Media Diagnostics</h1>
  <a href="/admin">Device Manager</a>
</header>
<main>
  <form class="filters" method="get">
    <label>Janus node
      <select name="janus">{''.join(node_options)}</select>
    </label>
    <label>ICE state contains
      <input type="text" name="ice" value="{ice_value}" placeholder="failed, connected, checking">
    </label>
    <label class="check"><input type="checkbox" name="failed" value="1"{failed_checked}> Failed media only</label>
    <button type="submit">Filter</button>
  </form>
  <section class="panel">
    <div class="panel-head"><h2>Recent calls</h2><span class="muted">{len(calls)} shown · max 250</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Started</th><th>Device</th><th>Janus</th><th>Media candidate</th>
          <th>ICE / media</th><th>Call</th><th>Details</th>
        </tr></thead>
        <tbody>{table_rows}</tbody>
      </table>
    </div>
  </section>
</main>
</body>
</html>""")


@app.get('/admin/calls/{call_id}', response_class=HTMLResponse)
async def admin_call_detail(call_id: str):
    try:
        call, events = store.admin_call_detail(call_id)
    except KeyError:
        raise HTTPException(404, 'call diagnostic not found')

    nickname = call.get('nickname') or call.get('sip_username') or 'Unknown device'
    peer = call.get('janus_peer_ip') or '—'
    peer_port = call.get('janus_peer_port')
    peer_text = f'{peer}:{peer_port}' if peer_port else peer
    media_ip = call.get('janus_media_ip') or '—'
    media_port = call.get('janus_media_port')
    media_text = f'{media_ip}:{media_port}' if media_port else media_ip

    timeline = []
    for event in events:
        details = event.get('details') or {}
        detail_text = ' · '.join(
            f'{html.escape(str(key))}={html.escape(str(value))}'
            for key, value in details.items()
            if value not in ('', None, 0)
        )
        timeline.append(f"""
          <div class="event">
            <div class="time">{html.escape(event.get('created_at') or '—')}</div>
            <div><strong>{html.escape(event.get('event') or 'event')}</strong>
            {'<div class="muted">' + detail_text + '</div>' if detail_text else ''}</div>
          </div>
        """)
    timeline_html = ''.join(timeline) or '<div class="empty">No timeline events recorded.</div>'

    fields = [
        ('Call reference', _safe_ref(call_id)),
        ('Device', str(nickname)),
        ('Direction', call.get('direction') or '—'),
        ('Janus peer', peer_text),
        ('Janus session', str(call.get('janus_session_id') or '—')),
        ('Janus handle', str(call.get('janus_handle_id') or '—')),
        ('Janus media candidate', media_text),
        ('Candidate type', call.get('janus_candidate_type') or '—'),
        ('ICE state', call.get('ice_state') or '—'),
        ('Peer state', call.get('peer_state') or '—'),
        ('Media status', call.get('media_status') or '—'),
        ('Call status', call.get('call_status') or '—'),
        ('Local candidates', str(call.get('local_candidates') if call.get('local_candidates') is not None else '—')),
        ('Remote candidates', str(call.get('remote_candidates') if call.get('remote_candidates') is not None else '—')),
        ('Local audio tracks', str(call.get('local_audio_tracks') if call.get('local_audio_tracks') is not None else '—')),
        ('Remote audio tracks', str(call.get('remote_audio_tracks') if call.get('remote_audio_tracks') is not None else '—')),
        ('Started', call.get('started_at') or '—'),
        ('Connected', call.get('connected_at') or '—'),
        ('Ended', call.get('ended_at') or '—'),
    ]
    field_html = ''.join(
        f'<div class="field"><span>{html.escape(label)}</span><strong>{html.escape(str(value))}</strong></div>'
        for label, value in fields
    )

    return HTMLResponse(f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Randy Call {_safe_ref(call_id)} · VoiceHost</title>
  <style>
    :root {{ color-scheme:light; --orange:#ff6600; --navy:#113b53; --bg:#f6f7f9; --card:#fff;
      --border:#e5e7eb; --muted:#6b7280; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      background:var(--bg); color:#17212b; }}
    header {{ background:var(--navy); color:white; padding:18px 28px; display:flex; justify-content:space-between; align-items:center; }}
    header h1 {{ margin:0; font-size:20px; }} header a {{ color:white; text-decoration:none; }}
    main {{ max-width:1150px; margin:28px auto; padding:0 20px; display:grid; grid-template-columns:1fr 1.3fr; gap:18px; }}
    .panel {{ background:var(--card); border:1px solid var(--border); border-radius:14px; overflow:hidden; }}
    .panel h2 {{ margin:0; padding:16px 18px; font-size:17px; border-bottom:1px solid var(--border); }}
    .fields {{ padding:8px 18px 16px; }}
    .field {{ display:flex; justify-content:space-between; gap:20px; padding:9px 0; border-bottom:1px solid #f0f1f3; }}
    .field span,.muted,.time {{ color:var(--muted); font-size:12px; }}
    .field strong {{ text-align:right; font-size:13px; word-break:break-word; }}
    .timeline {{ padding:8px 18px 18px; }}
    .event {{ display:grid; grid-template-columns:145px 1fr; gap:14px; padding:11px 0; border-bottom:1px solid #f0f1f3; }}
    .empty {{ padding:24px 0; color:var(--muted); }}
    @media(max-width:850px) {{ main {{ grid-template-columns:1fr; }} }}
  </style>
</head>
<body>
<header><h1>Call {_safe_ref(call_id)}</h1><a href="/admin/calls">← Calls / Media</a></header>
<main>
  <section class="panel"><h2>Call / media state</h2><div class="fields">{field_html}</div></section>
  <section class="panel"><h2>Diagnostic timeline</h2><div class="timeline">{timeline_html}</div></section>
</main>
</body>
</html>""")



@app.post('/admin/devices/{device_id}/test-push', dependencies=[Depends(admin_action)])
async def admin_test_push(device_id: str):
    environment = await _send_test_push(device_id)
    return {'ok': True, 'environment': environment}


@app.post('/admin/devices/{device_id}/delete', dependencies=[Depends(admin_action)])
async def admin_delete_device(device_id: str):
    try:
        store.get(device_id)
    except KeyError:
        raise HTTPException(404, 'device not found')

    if manager.device_calls.get(device_id):
        raise HTTPException(
            status_code=409,
            detail='device has active calls; end them before deleting',
        )
    if device_id in manager.device_transfer:
        raise HTTPException(
            status_code=409,
            detail='device has an active transfer; end it before deleting',
        )

    await manager.remove_device(device_id)
    deleted = store.delete(device_id)
    if not deleted:
        raise HTTPException(404, 'device not found')

    diag_logger.info(
        '[VH-DIAG] event=admin_device_deleted device=%s',
        _safe_ref(device_id),
    )
    return {'ok': True}


@app.post('/v1/devices/register', dependencies=[Depends(auth)])
async def register_device(body: DeviceRegistration):
    device = store.upsert(body)
    asyncio.create_task(manager.ensure_session(device))
    return {'ok': True, 'device_id': device.device_id}


@app.post('/v1/devices/{device_id}/test-push', dependencies=[Depends(auth)])
async def test_push(device_id: str):
    environment = await _send_test_push(device_id)
    return {'ok': True, 'environment': environment}


@app.get('/v1/devices/{device_id}/voicemail', dependencies=[Depends(auth)])
async def voicemail(device_id: str):
    try:
        summary = manager.voicemail_summary(device_id)
    except KeyError:
        raise HTTPException(404, 'device not found')
    return {'ok': True, **summary}


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
    except RuntimeError as error:
        raise HTTPException(409, str(error))
    return {'ok': True}


@app.post('/v1/calls/{call_id}/decline', dependencies=[Depends(auth)])
async def decline(call_id: str):
    try:
        await manager.decline(call_id)
    except KeyError:
        raise HTTPException(404, 'call not found')
    except RuntimeError as error:
        raise HTTPException(409, str(error))
    return {'ok': True}


@app.post('/v1/calls/{call_id}/hangup', dependencies=[Depends(auth)])
async def hangup(call_id: str):
    try:
        await manager.hangup(call_id)
    except KeyError:
        raise HTTPException(404, 'call not found')
    except RuntimeError as error:
        raise HTTPException(409, str(error))
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
    except RuntimeError as error:
        raise HTTPException(409, str(error))
    return {'ok': True}


@app.post('/v1/calls/{call_id}/dtmf', dependencies=[Depends(auth)])
async def dtmf(call_id: str, body: DtmfRequest):
    try:
        await manager.dtmf(call_id, body.digit, body.duration)
    except KeyError:
        raise HTTPException(404, 'call not found')
    except RuntimeError as error:
        raise HTTPException(409, str(error))
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
    store.add_call_event(body.call_id, body.event, safe_details)
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
