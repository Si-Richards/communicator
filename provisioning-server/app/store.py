import hashlib
import json
import secrets
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class Store:
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.RLock()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS activations (
                    id TEXT PRIMARY KEY,
                    code_hash TEXT UNIQUE NOT NULL,
                    config_json TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    consumed_at TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS devices (
                    id TEXT PRIMARY KEY,
                    installation_id TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    device_type TEXT NOT NULL,
                    device_name TEXT,
                    app_version TEXT NOT NULL,
                    app_build INTEGER NOT NULL,
                    os_version TEXT,
                    state TEXT NOT NULL,
                    configuration_version INTEGER NOT NULL,
                    config_json TEXT NOT NULL,
                    push_json TEXT,
                    last_seen_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS refresh_tokens (
                    token_hash TEXT PRIMARY KEY,
                    device_id TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    revoked_at TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(device_id) REFERENCES devices(id)
                );

                CREATE TABLE IF NOT EXISTS access_tokens (
                    token_hash TEXT PRIMARY KEY,
                    device_id TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    revoked_at TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(device_id) REFERENCES devices(id)
                );

                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event TEXT NOT NULL,
                    device_id TEXT,
                    detail_json TEXT,
                    created_at TEXT NOT NULL
                );
                """
            )

    def create_activation(
        self,
        config: dict[str, Any],
        ttl_seconds: int,
    ) -> tuple[str, str, str]:
        activation_id = "act_" + secrets.token_hex(12)
        raw = secrets.token_hex(4).upper()
        code = f"VH{raw[:4]}-{raw[4:]}"
        now = utcnow()
        expires = now + timedelta(seconds=ttl_seconds)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO activations
                    (id, code_hash, config_json, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    activation_id,
                    hash_secret(code),
                    json.dumps(config),
                    iso(expires),
                    iso(now),
                ),
            )
        return activation_id, code, iso(expires)

    def consume_activation(self, code: str) -> dict[str, Any] | None:
        digest = hash_secret(code.strip().upper())
        with self._lock, self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM activations WHERE code_hash = ?",
                (digest,),
            ).fetchone()
            if row is None:
                conn.rollback()
                return None
            if row["consumed_at"] is not None or parse_time(row["expires_at"]) <= utcnow():
                conn.rollback()
                return None
            conn.execute(
                "UPDATE activations SET consumed_at = ? WHERE id = ?",
                (iso(utcnow()), row["id"]),
            )
            conn.commit()
            return json.loads(row["config_json"])

    def create_device(
        self,
        descriptor: dict[str, Any],
        config: dict[str, Any],
        push: dict[str, Any] | None,
    ) -> dict[str, Any]:
        now = utcnow()
        device_id = "dev_" + secrets.token_hex(12)
        state = "active"
        version = int(config.get("version", 1))
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO devices (
                    id, installation_id, platform, device_type, device_name,
                    app_version, app_build, os_version, state,
                    configuration_version, config_json, push_json,
                    last_seen_at, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    device_id,
                    descriptor["installation_id"],
                    descriptor["platform"],
                    descriptor["device_type"],
                    descriptor.get("device_name"),
                    descriptor["app_version"],
                    descriptor["app_build"],
                    descriptor.get("os_version"),
                    state,
                    version,
                    json.dumps(config),
                    json.dumps(push) if push else None,
                    iso(now),
                    iso(now),
                    iso(now),
                ),
            )
        return self.get_device(device_id)

    def get_device(self, device_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM devices WHERE id = ?",
                (device_id,),
            ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["config"] = json.loads(result.pop("config_json"))
        result["push"] = (
            json.loads(result.pop("push_json"))
            if result.get("push_json")
            else None
        )
        return result

    def update_checkin(
        self,
        device_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        now = utcnow()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE devices
                SET app_version = ?, app_build = ?, os_version = ?,
                    push_json = COALESCE(?, push_json),
                    last_seen_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    payload["app_version"],
                    payload["app_build"],
                    payload.get("os_version"),
                    json.dumps(payload["push"]) if payload.get("push") else None,
                    iso(now),
                    iso(now),
                    device_id,
                ),
            )
        return self.get_device(device_id)

    def update_push(
        self,
        device_id: str,
        tokens: list[dict[str, Any]],
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE devices
                SET push_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (json.dumps({"tokens": tokens}), iso(utcnow()), device_id),
            )

    def set_device_state(self, device_id: str, state: str) -> bool:
        now = utcnow()
        with self._connect() as conn:
            cur = conn.execute(
                """
                UPDATE devices
                SET state = ?, updated_at = ?
                WHERE id = ?
                """,
                (state, iso(now), device_id),
            )
            if state in {"revoked", "retired"}:
                conn.execute(
                    """
                    UPDATE access_tokens
                    SET revoked_at = ?
                    WHERE device_id = ? AND revoked_at IS NULL
                    """,
                    (iso(now), device_id),
                )
                conn.execute(
                    """
                    UPDATE refresh_tokens
                    SET revoked_at = ?
                    WHERE device_id = ? AND revoked_at IS NULL
                    """,
                    (iso(now), device_id),
                )
        return cur.rowcount > 0

    def issue_tokens(
        self,
        device_id: str,
        access_ttl: int,
        refresh_ttl: int = 60 * 60 * 24 * 30,
    ) -> tuple[str, str, int]:
        now = utcnow()
        access = secrets.token_urlsafe(32)
        refresh = secrets.token_urlsafe(48)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO access_tokens
                    (token_hash, device_id, expires_at, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    hash_secret(access),
                    device_id,
                    iso(now + timedelta(seconds=access_ttl)),
                    iso(now),
                ),
            )
            conn.execute(
                """
                INSERT INTO refresh_tokens
                    (token_hash, device_id, expires_at, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    hash_secret(refresh),
                    device_id,
                    iso(now + timedelta(seconds=refresh_ttl)),
                    iso(now),
                ),
            )
        return access, refresh, access_ttl

    def authenticate_access(self, token: str) -> dict[str, Any] | None:
        digest = hash_secret(token)
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT device_id, expires_at, revoked_at
                FROM access_tokens
                WHERE token_hash = ?
                """,
                (digest,),
            ).fetchone()
        if (
            row is None
            or row["revoked_at"] is not None
            or parse_time(row["expires_at"]) <= utcnow()
        ):
            return None
        return self.get_device(row["device_id"])

    def rotate_refresh(
        self,
        token: str,
        access_ttl: int,
    ) -> tuple[dict[str, Any], str, str, int] | None:
        digest = hash_secret(token)
        with self._lock, self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT device_id, expires_at, revoked_at
                FROM refresh_tokens
                WHERE token_hash = ?
                """,
                (digest,),
            ).fetchone()
            if (
                row is None
                or row["revoked_at"] is not None
                or parse_time(row["expires_at"]) <= utcnow()
            ):
                conn.rollback()
                return None
            device = self.get_device(row["device_id"])
            if device is None or device["state"] in {"revoked", "retired"}:
                conn.rollback()
                return None
            now = utcnow()
            conn.execute(
                """
                UPDATE refresh_tokens SET revoked_at = ?
                WHERE token_hash = ?
                """,
                (iso(now), digest),
            )
            conn.commit()

        access, refresh, ttl = self.issue_tokens(device["id"], access_ttl)
        return device, access, refresh, ttl

    def revoke_device_tokens(self, device_id: str) -> None:
        now = iso(utcnow())
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE access_tokens SET revoked_at = ?
                WHERE device_id = ? AND revoked_at IS NULL
                """,
                (now, device_id),
            )
            conn.execute(
                """
                UPDATE refresh_tokens SET revoked_at = ?
                WHERE device_id = ? AND revoked_at IS NULL
                """,
                (now, device_id),
            )

    def audit(
        self,
        event: str,
        device_id: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO audit_log
                    (event, device_id, detail_json, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    event,
                    device_id,
                    json.dumps(detail) if detail else None,
                    iso(utcnow()),
                ),
            )
