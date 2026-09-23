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

    def _row(self, row) -> DeviceRecord:
        return DeviceRecord(
            device_id=row['device_id'], platform=row['platform'], push_token=row['push_token'],
            sip_username=row['sip_username'],
            sip_password=self.fernet.decrypt(row['sip_password']).decode(),
            sip_realm=row['sip_realm'], sip_proxy=row['sip_proxy'], nickname=row['nickname'],
            dnd=bool(row['dnd']),
        )
