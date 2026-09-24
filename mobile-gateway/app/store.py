import json
import sqlite3
import threading
from cryptography.fernet import Fernet

from .models import DeviceRecord, DeviceRegistration


class DeviceStore:
    def __init__(self, path, encryption_key: str):
        self.path = str(path)
        self.fernet = Fernet(encryption_key.encode())
        self.lock = threading.Lock()
        self._init_db()

    def _connect(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        with self.lock, self._connect() as db:
            db.execute('''
                CREATE TABLE IF NOT EXISTS devices (
                    device_id TEXT PRIMARY KEY,
                    platform TEXT NOT NULL,
                    push_token TEXT NOT NULL,
                    sip_username TEXT NOT NULL,
                    sip_password BLOB NOT NULL,
                    sip_realm TEXT NOT NULL,
                    sip_proxy TEXT,
                    nickname TEXT NOT NULL,
                    dnd INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            db.execute('''
                CREATE TABLE IF NOT EXISTS call_diagnostics (
                    call_id TEXT PRIMARY KEY,
                    device_id TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    janus_peer_ip TEXT,
                    janus_peer_port INTEGER,
                    janus_session_id INTEGER,
                    janus_handle_id INTEGER,
                    sip_call_id TEXT,
                    janus_candidate_type TEXT,
                    janus_media_ip TEXT,
                    janus_media_port INTEGER,
                    ice_state TEXT,
                    peer_state TEXT,
                    local_candidates INTEGER,
                    remote_candidates INTEGER,
                    local_audio_tracks INTEGER,
                    remote_audio_tracks INTEGER,
                    call_status TEXT NOT NULL DEFAULT 'starting',
                    media_status TEXT NOT NULL DEFAULT 'unknown',
                    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    connected_at TEXT,
                    ended_at TEXT,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            db.execute('''
                CREATE TABLE IF NOT EXISTS call_diagnostic_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    call_id TEXT NOT NULL,
                    event TEXT NOT NULL,
                    details TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            db.execute(
                'CREATE INDEX IF NOT EXISTS idx_call_diag_started '
                'ON call_diagnostics(started_at DESC)'
            )
            db.execute(
                'CREATE INDEX IF NOT EXISTS idx_call_diag_node '
                'ON call_diagnostics(janus_peer_ip, started_at DESC)'
            )
            db.execute(
                'CREATE INDEX IF NOT EXISTS idx_call_diag_events '
                'ON call_diagnostic_events(call_id, id)'
            )
            db.commit()

    def upsert(self, item: DeviceRegistration) -> DeviceRecord:
        encrypted = self.fernet.encrypt(item.sip_password.encode())
        with self.lock, self._connect() as db:
            db.execute('''
                INSERT INTO devices(device_id, platform, push_token, sip_username,
                    sip_password, sip_realm, sip_proxy, nickname, dnd, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(device_id) DO UPDATE SET
                    platform=excluded.platform, push_token=excluded.push_token,
                    sip_username=excluded.sip_username, sip_password=excluded.sip_password,
                    sip_realm=excluded.sip_realm, sip_proxy=excluded.sip_proxy,
                    nickname=excluded.nickname, dnd=excluded.dnd,
                    updated_at=CURRENT_TIMESTAMP
            ''', (
                item.device_id, item.platform, item.push_token, item.sip_username,
                encrypted, item.sip_realm, item.sip_proxy, item.nickname, int(item.dnd),
            ))
            db.commit()
        return self.get(item.device_id)

    def get(self, device_id: str) -> DeviceRecord:
        with self.lock, self._connect() as db:
            row = db.execute('SELECT * FROM devices WHERE device_id=?', (device_id,)).fetchone()
        if row is None:
            raise KeyError(device_id)
        return self._row(row)

    def all(self) -> list[DeviceRecord]:
        with self.lock, self._connect() as db:
            rows = db.execute('SELECT * FROM devices').fetchall()
        return [self._row(row) for row in rows]

    def admin_list(self) -> list[dict]:
        with self.lock, self._connect() as db:
            rows = db.execute(
                '''
                SELECT device_id, platform, sip_username, sip_realm, nickname,
                       dnd, updated_at
                FROM devices
                ORDER BY updated_at DESC, sip_username ASC
                '''
            ).fetchall()
        return [
            {
                'device_id': row['device_id'],
                'platform': row['platform'],
                'sip_username': row['sip_username'],
                'sip_realm': row['sip_realm'],
                'nickname': row['nickname'],
                'dnd': bool(row['dnd']),
                'updated_at': row['updated_at'],
            }
            for row in rows
        ]

    def delete(self, device_id: str) -> bool:
        with self.lock, self._connect() as db:
            cursor = db.execute(
                'DELETE FROM devices WHERE device_id=?',
                (device_id,),
            )
            db.commit()
            return cursor.rowcount > 0

    def begin_call(
        self,
        call_id: str,
        device_id: str,
        direction: str,
        *,
        janus_peer_ip: str | None = None,
        janus_peer_port: int | None = None,
        janus_session_id: int | None = None,
        janus_handle_id: int | None = None,
        sip_call_id: str | None = None,
    ):
        with self.lock, self._connect() as db:
            db.execute(
                '''
                INSERT INTO call_diagnostics(
                    call_id, device_id, direction, janus_peer_ip, janus_peer_port,
                    janus_session_id, janus_handle_id, sip_call_id
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(call_id) DO UPDATE SET
                    janus_peer_ip=COALESCE(excluded.janus_peer_ip, janus_peer_ip),
                    janus_peer_port=COALESCE(excluded.janus_peer_port, janus_peer_port),
                    janus_session_id=COALESCE(excluded.janus_session_id, janus_session_id),
                    janus_handle_id=COALESCE(excluded.janus_handle_id, janus_handle_id),
                    sip_call_id=COALESCE(excluded.sip_call_id, sip_call_id),
                    updated_at=CURRENT_TIMESTAMP
                ''',
                (
                    call_id, device_id, direction, janus_peer_ip, janus_peer_port,
                    janus_session_id, janus_handle_id, sip_call_id,
                ),
            )
            db.commit()
        self.add_call_event(call_id, 'call_started', {
            'direction': direction,
            'janus_peer_ip': janus_peer_ip or '',
            'janus_peer_port': janus_peer_port or 0,
            'janus_session_id': janus_session_id or 0,
            'janus_handle_id': janus_handle_id or 0,
        })

    def update_call(self, call_id: str, **fields):
        allowed = {
            'janus_peer_ip', 'janus_peer_port', 'janus_session_id',
            'janus_handle_id', 'sip_call_id', 'janus_candidate_type',
            'janus_media_ip', 'janus_media_port', 'ice_state', 'peer_state',
            'local_candidates', 'remote_candidates', 'local_audio_tracks',
            'remote_audio_tracks', 'call_status', 'media_status',
        }
        values = {key: value for key, value in fields.items() if key in allowed}
        if not values:
            return
        assignments = ', '.join(f'{key}=?' for key in values)
        with self.lock, self._connect() as db:
            db.execute(
                f'UPDATE call_diagnostics SET {assignments}, '
                'updated_at=CURRENT_TIMESTAMP WHERE call_id=?',
                (*values.values(), call_id),
            )
            db.commit()

    def mark_call_connected(self, call_id: str):
        with self.lock, self._connect() as db:
            db.execute(
                '''
                UPDATE call_diagnostics
                SET call_status='connected',
                    connected_at=COALESCE(connected_at, CURRENT_TIMESTAMP),
                    updated_at=CURRENT_TIMESTAMP
                WHERE call_id=?
                ''',
                (call_id,),
            )
            db.commit()
        self.add_call_event(call_id, 'call_connected', {})

    def end_call(self, call_id: str, status: str = 'ended', details: dict | None = None):
        with self.lock, self._connect() as db:
            db.execute(
                '''
                UPDATE call_diagnostics
                SET call_status=?, ended_at=COALESCE(ended_at, CURRENT_TIMESTAMP),
                    updated_at=CURRENT_TIMESTAMP
                WHERE call_id=?
                ''',
                (status, call_id),
            )
            db.commit()
        self.add_call_event(call_id, 'call_ended', details or {'status': status})

    def add_call_event(self, call_id: str | None, event: str, details: dict):
        if not call_id:
            return
        safe_details = {
            str(key): value
            for key, value in details.items()
            if isinstance(value, (str, int, bool, float)) or value is None
        }
        with self.lock, self._connect() as db:
            db.execute(
                '''
                INSERT INTO call_diagnostic_events(call_id, event, details)
                VALUES (?, ?, ?)
                ''',
                (call_id, event, json.dumps(safe_details, separators=(',', ':'))),
            )

            updates = {}
            for key in (
                'ice_state', 'peer_state', 'local_candidates', 'remote_candidates',
                'local_audio_tracks', 'remote_audio_tracks',
            ):
                if key in safe_details:
                    updates[key] = safe_details[key]

            ice_state = str(safe_details.get('ice_state', '')).lower()
            if ice_state:
                if ice_state.endswith('stateconnected') or ice_state.endswith('statecompleted'):
                    updates['media_status'] = 'connected'
                elif ice_state.endswith('statefailed'):
                    updates['media_status'] = 'failed'
                elif ice_state.endswith('statedisconnected'):
                    updates['media_status'] = 'disconnected'
                elif ice_state.endswith('statechecking'):
                    updates['media_status'] = 'checking'

            if updates:
                assignments = ', '.join(f'{key}=?' for key in updates)
                db.execute(
                    f'UPDATE call_diagnostics SET {assignments}, '
                    'updated_at=CURRENT_TIMESTAMP WHERE call_id=?',
                    (*updates.values(), call_id),
                )

            # Keep the diagnostic store bounded without touching live call rows.
            db.execute(
                '''
                DELETE FROM call_diagnostic_events
                WHERE id IN (
                    SELECT id FROM call_diagnostic_events
                    ORDER BY id DESC
                    LIMIT -1 OFFSET 10000
                )
                '''
            )
            db.execute(
                '''
                DELETE FROM call_diagnostics
                WHERE call_id IN (
                    SELECT call_id FROM call_diagnostics
                    WHERE ended_at IS NOT NULL
                    ORDER BY started_at DESC
                    LIMIT -1 OFFSET 1000
                )
                '''
            )
            db.commit()

    def admin_calls(
        self,
        *,
        limit: int = 200,
        janus_peer_ip: str | None = None,
        ice_state: str | None = None,
        failed_only: bool = False,
    ) -> list[dict]:
        clauses = []
        params: list[object] = []
        if janus_peer_ip:
            clauses.append('c.janus_peer_ip=?')
            params.append(janus_peer_ip)
        if ice_state:
            clauses.append('c.ice_state LIKE ?')
            params.append(f'%{ice_state}%')
        if failed_only:
            clauses.append("(c.media_status='failed' OR c.call_status='failed')")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ''
        params.append(max(1, min(limit, 500)))

        with self.lock, self._connect() as db:
            rows = db.execute(
                f'''
                SELECT c.*, d.nickname, d.sip_username, d.platform
                FROM call_diagnostics c
                LEFT JOIN devices d ON d.device_id=c.device_id
                {where}
                ORDER BY c.started_at DESC
                LIMIT ?
                ''',
                tuple(params),
            ).fetchall()
        return [dict(row) for row in rows]

    def admin_call_detail(self, call_id: str) -> tuple[dict, list[dict]]:
        with self.lock, self._connect() as db:
            call = db.execute(
                '''
                SELECT c.*, d.nickname, d.sip_username, d.platform
                FROM call_diagnostics c
                LEFT JOIN devices d ON d.device_id=c.device_id
                WHERE c.call_id=?
                ''',
                (call_id,),
            ).fetchone()
            if call is None:
                raise KeyError(call_id)
            rows = db.execute(
                '''
                SELECT event, details, created_at
                FROM call_diagnostic_events
                WHERE call_id=?
                ORDER BY id ASC
                ''',
                (call_id,),
            ).fetchall()

        events = []
        for row in rows:
            try:
                details = json.loads(row['details'])
            except (TypeError, json.JSONDecodeError):
                details = {}
            events.append({
                'event': row['event'],
                'details': details,
                'created_at': row['created_at'],
            })
        return dict(call), events

    def janus_nodes(self) -> list[str]:
        with self.lock, self._connect() as db:
            rows = db.execute(
                '''
                SELECT DISTINCT janus_peer_ip
                FROM call_diagnostics
                WHERE janus_peer_ip IS NOT NULL AND janus_peer_ip != ''
                ORDER BY janus_peer_ip
                '''
            ).fetchall()
        return [row['janus_peer_ip'] for row in rows]

    def _row(self, row) -> DeviceRecord:
        return DeviceRecord(
            device_id=row['device_id'], platform=row['platform'], push_token=row['push_token'],
            sip_username=row['sip_username'],
            sip_password=self.fernet.decrypt(row['sip_password']).decode(),
            sip_realm=row['sip_realm'], sip_proxy=row['sip_proxy'], nickname=row['nickname'],
            dnd=bool(row['dnd']),
        )
