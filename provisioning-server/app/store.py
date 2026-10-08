import base64
import hashlib
import hmac
import json
import secrets
import sqlite3
import threading
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .messaging_identity import identity_for_jid, canonical_jid, provisioned_extension


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class Store:
    def __init__(self, path: str, retry_key: str = '', retry_grace_seconds: int = 30):
        self.path = path
        self._retry_key = retry_key.encode('utf-8')
        self._retry_grace_seconds = retry_grace_seconds
        self._lock = threading.RLock()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._init()

    @contextmanager
    def _connect(self):
        """Manage transactions and always close the SQLite connection."""
        conn = sqlite3.connect(self.path, timeout=30)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            with conn:
                yield conn
        finally:
            conn.close()

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
                CREATE TABLE IF NOT EXISTS messaging_accounts (
                    jid TEXT PRIMARY KEY,
                    password TEXT NOT NULL,
                    owned INTEGER NOT NULL DEFAULT 0,
                    applied_enabled INTEGER,
                    attempted_enabled INTEGER,
                    status TEXT NOT NULL DEFAULT 'pending',
                    error TEXT,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_retry_at TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messaging_aliases (
                    old_jid TEXT PRIMARY KEY,
                    canonical_jid TEXT NOT NULL,
                    history_done INTEGER NOT NULL DEFAULT 0
                );
                """
            )
            # Additive migration: retain shared passwords, accounts and history.
            conn.execute("BEGIN IMMEDIATE")
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(messaging_accounts)")}
            for column in ("account_number", "extension", "applied_directory_signature", "directory_synced_at"):
                if column not in columns:
                    conn.execute(f"ALTER TABLE messaging_accounts ADD COLUMN {column} TEXT")
            for account in conn.execute("SELECT * FROM messaging_accounts").fetchall():
                try:
                    number, extension = identity_for_jid(account["jid"])
                except ValueError:
                    # Legacy identities without an account prefix need an admin
                    # correction. Never infer a shared/default tenant for them.
                    conn.execute("UPDATE messaging_accounts SET status='error', error=? WHERE jid=?",
                                 ("Managed messaging requires an accountnumber*extension SIP username.", account["jid"]))
                    continue
                conn.execute("UPDATE messaging_accounts SET account_number=?, extension=? WHERE jid=?",
                             (number, extension, account["jid"]))
            self._migrate_endpoint_accounts(conn)
            for row in conn.execute("SELECT id,config_json,configuration_version FROM devices").fetchall():
                config = json.loads(row["config_json"])
                messaging = config.get("messaging") or {}
                if not messaging.get("managed") or not messaging.get("enabled"):
                    continue
                account = conn.execute("SELECT * FROM messaging_accounts WHERE jid=?", (messaging.get("jid"),)).fetchone()
                if not account:
                    continue
                updated = {**messaging, "account_number": account["account_number"], "extension": account["extension"]}
                if not account["applied_directory_signature"]:
                    updated["ready"] = False
                if updated != messaging:
                    config["messaging"] = updated
                    config["version"] = row["configuration_version"] + 1
                    conn.execute("UPDATE devices SET config_json=?,configuration_version=?,updated_at=? WHERE id=?",
                                 (json.dumps(config), config["version"], iso(utcnow()), row["id"]))

    def _migrate_endpoint_accounts(self, conn):
        """Idempotent local reservation; the worker proves remote ownership later."""
        devices = conn.execute("SELECT * FROM devices ORDER BY created_at,id").fetchall()
        manual = {m.get("jid") for row in devices
                  if (m := (json.loads(row["config_json"]).get("messaging") or {})).get("enabled")
                  and not m.get("managed")}
        # Keep every source account/password. Never adopt an existing manual JID.
        for old in conn.execute("SELECT * FROM messaging_accounts ORDER BY created_at,jid").fetchall():
            try:
                target = canonical_jid(old["jid"])
            except ValueError:
                continue
            if target == old["jid"]:
                continue
            if target in manual:
                raise ValueError("Canonical messaging identity is already assigned manually; administrator action is required.")
            previous = conn.execute("SELECT canonical_jid FROM messaging_aliases WHERE old_jid=?", (old["jid"],)).fetchone()
            if previous and previous[0] != target:
                raise ValueError("Messaging endpoint migration conflicts with existing ownership.")
            number, extension = identity_for_jid(target)
            conn.execute("""INSERT OR IGNORE INTO messaging_accounts
                (jid,password,created_at,account_number,extension) VALUES (?,?,?,?,?)""",
                (target, old["password"], old["created_at"], number, extension))
            inserted = conn.execute("INSERT OR IGNORE INTO messaging_aliases (old_jid,canonical_jid) VALUES (?,?)",
                                    (old["jid"], target)).rowcount
            if inserted:
                conn.execute("""UPDATE messaging_accounts SET status='pending', error=NULL,
                    applied_directory_signature=NULL, next_retry_at=NULL, attempts=0 WHERE jid=?""", (target,))
        for row in devices:
            config = json.loads(row["config_json"])
            messaging = config.get("messaging") or {}
            old_jid = messaging.get("jid")
            if not messaging.get("managed") or not old_jid:
                continue
            alias = conn.execute("SELECT canonical_jid FROM messaging_aliases WHERE old_jid=?", (old_jid,)).fetchone()
            target = alias[0] if alias else old_jid
            account = conn.execute("SELECT * FROM messaging_accounts WHERE jid=?", (target,)).fetchone()
            if not account:
                continue
            previous_jids = [r[0] for r in conn.execute("SELECT old_jid FROM messaging_aliases WHERE canonical_jid=? ORDER BY old_jid", (target,))]
            updated = {**messaging, "jid": target, "previous_jids": previous_jids}
            if messaging.get("enabled"):
                updated.update(password=account["password"], account_number=account["account_number"], extension=account["extension"])
                if target != old_jid or account["status"] != "enabled":
                    updated["ready"] = False
            if updated != messaging:
                config["messaging"] = updated
                config["version"] = row["configuration_version"] + 1
                conn.execute("UPDATE devices SET config_json=?,configuration_version=?,updated_at=? WHERE id=?",
                             (json.dumps(config), config["version"], iso(utcnow()), row["id"]))

    def activate_device(self, code: str, descriptor: dict, config_factory, push: dict | None,
                        access_ttl: int, refresh_ttl: int = 60 * 60 * 24 * 30):
        """Consume an activation, register an installation and issue tokens atomically.

        A duplicate active installation is rejected without consuming its code.
        Administrators must explicitly retire/revoke the old installation first.
        """
        now = utcnow()
        device_id = "dev_" + secrets.token_hex(12)
        access = secrets.token_urlsafe(32)
        refresh = secrets.token_urlsafe(48)
        with self._lock, self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            activation = conn.execute(
                "SELECT * FROM activations WHERE code_hash = ?",
                (hash_secret(code.strip().upper()),),
            ).fetchone()
            if (activation is None or activation["consumed_at"] is not None
                    or parse_time(activation["expires_at"]) <= now):
                return None, "activation_code_invalid"
            existing = conn.execute(
                """SELECT id, state FROM devices
                   WHERE installation_id = ? AND platform = ?
                   ORDER BY created_at DESC""",
                (descriptor["installation_id"], descriptor["platform"]),
            ).fetchall()
            if any(item["state"] not in ("revoked", "retired") for item in existing):
                return None, "installation_already_registered"
            source = json.loads(activation["config_json"])
            config = config_factory(source)
            config = self._prepare_messaging(conn, config)
            conn.execute(
                """INSERT INTO devices (
                    id, installation_id, platform, device_type, device_name,
                    app_version, app_build, os_version, state,
                    configuration_version, config_json, push_json,
                    last_seen_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (device_id, descriptor["installation_id"], descriptor["platform"],
                 descriptor["device_type"], descriptor.get("device_name"),
                 descriptor["app_version"], descriptor["app_build"],
                 descriptor.get("os_version"), "active",
                 int(config.get("version", 1)), json.dumps(config),
                 json.dumps(push) if push else None, iso(now), iso(now), iso(now)),
            )
            conn.execute(
                "INSERT INTO access_tokens (token_hash, device_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                (hash_secret(access), device_id, iso(now + timedelta(seconds=access_ttl)), iso(now)),
            )
            conn.execute(
                "INSERT INTO refresh_tokens (token_hash, device_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                (hash_secret(refresh), device_id, iso(now + timedelta(seconds=refresh_ttl)), iso(now)),
            )
            conn.execute("UPDATE activations SET consumed_at = ? WHERE id = ?",
                         (iso(now), activation["id"]))
            conn.execute(
                "INSERT INTO audit_log (event, device_id, detail_json, created_at) VALUES (?, ?, ?, ?)",
                ("device_activated", device_id, json.dumps({"activation_id": activation["id"]}), iso(now)),
            )
        return (device_id, access, refresh, access_ttl, config), None

    def list_devices(self, limit: int = 50, offset: int = 0,
                     state: str | None = None, query: str | None = None) -> dict:
        conditions = []
        params: list = []
        if state is not None:
            conditions.append("state = ?")
            params.append(state)
        if query:
            conditions.append("(installation_id LIKE ? OR device_name LIKE ? OR id LIKE ?)")
            pattern = "%" + query + "%"
            params.extend([pattern] * 3)
        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        with self._connect() as conn:
            count = conn.execute("SELECT COUNT(*) FROM devices" + where, params).fetchone()[0]
            rows = conn.execute(
                """SELECT id, installation_id, platform, device_type, device_name,
                          app_version, app_build, os_version, state,
                          configuration_version, last_seen_at, created_at, updated_at
                   FROM devices""" + where +
                " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                [*params, limit, offset],
            ).fetchall()
        return {"items": [dict(row) for row in rows], "total": count,
                "limit": limit, "offset": offset}

    def housekeeping(self, retention_days: int = 90, dry_run: bool = True) -> dict:
        """Prune only expired credential/activation rows; retain devices and audit history."""
        cutoff = iso(utcnow() - timedelta(days=retention_days))
        rules = {
            "access_tokens": "(expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)) AND created_at < ?",
            "refresh_tokens": "(expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)) AND created_at < ?",
            "activations": "(expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)) AND created_at < ?",
        }
        results = {}
        with self._lock, self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            for table, predicate in rules.items():
                args = (cutoff, cutoff, cutoff)
                results[table] = conn.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE {predicate}", args
                ).fetchone()[0]
                if not dry_run:
                    conn.execute(f"DELETE FROM {table} WHERE {predicate}", args)
            if dry_run:
                conn.rollback()
        return {"dry_run": dry_run, "retention_days": retention_days, "deleted_or_eligible": results}

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
            conn.execute("BEGIN IMMEDIATE")
            config = self._prepare_messaging(conn, config)
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

    def update_device_configuration(
        self,
        device_id: str,
        config: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Replace managed configuration and advance its version atomically."""
        now = utcnow()
        with self._lock, self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT configuration_version, state FROM devices WHERE id = ?",
                (device_id,),
            ).fetchone()
            if row is None:
                return None
            version = int(row["configuration_version"]) + 1
            updated = self._prepare_messaging(conn, config)
            updated["version"] = version
            updated["device"] = dict(updated.get("device", {}))
            updated["device"]["state"] = row["state"]
            conn.execute(
                """
                UPDATE devices
                SET configuration_version = ?, config_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (version, json.dumps(updated), iso(now), device_id),
            )
            conn.commit()
        return self.get_device(device_id)

    def _prepare_messaging(self, conn, config: dict) -> dict:
        """Reserve a stable shared secret in the device mutation transaction."""
        config = dict(config)
        messaging = dict(config.get("messaging") or {})
        if not messaging.get("enabled"):
            return config
        jid = messaging.get("jid")
        account = conn.execute("SELECT * FROM messaging_accounts WHERE jid = ?", (jid,)).fetchone()
        if not messaging.get("managed"):
            if account:
                raise ValueError("This messaging identity is managed automatically; use automatic messaging.")
            return config
        if canonical_jid(jid) != jid:
            raise ValueError("Managed messaging must use the canonical numeric extension JID.")
        telephony = config.get("telephony") or {}
        if (telephony.get("sip") or {}).get("username"):
            provisioned_extension(telephony.get("extension"), telephony["sip"]["username"])
        # Do not silently take control of an identity already assigned manually.
        for row in conn.execute("SELECT config_json FROM devices"):
            other = json.loads(row["config_json"]).get("messaging") or {}
            if other.get("enabled") and other.get("jid") == jid and not other.get("managed"):
                raise ValueError("This messaging identity is already assigned manually.")
        if account is None:
            number, extension = identity_for_jid(jid)
            conn.execute(
                "INSERT INTO messaging_accounts (jid, password, created_at, account_number, extension) VALUES (?, ?, ?, ?, ?)",
                (jid, secrets.token_urlsafe(48), iso(utcnow()), number, extension),
            )
            account = conn.execute("SELECT * FROM messaging_accounts WHERE jid = ?", (jid,)).fetchone()
        messaging["password"] = account["password"]
        messaging["account_number"] = account["account_number"]
        messaging["extension"] = account["extension"]
        messaging["previous_jids"] = [r[0] for r in conn.execute(
            "SELECT old_jid FROM messaging_aliases WHERE canonical_jid=? ORDER BY old_jid", (jid,))]
        messaging["ready"] = (account["status"] == "enabled" and account["applied_enabled"] == 1
                              and bool(account["applied_directory_signature"]))
        config["messaging"] = messaging
        return config

    @staticmethod
    def messaging_active_references(conn, jid: str) -> int:
        count = 0
        for row in conn.execute("SELECT state, config_json FROM devices"):
            config = json.loads(row["config_json"])
            messaging = config.get("messaging") or {}
            if (row["state"] == "active" and messaging.get("managed")
                    and messaging.get("enabled") and messaging.get("jid") == jid
                    and config.get("features", {}).get("messaging") is not False):
                count += 1
        return count

    def messaging_account_status(self, jid: str) -> dict | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM messaging_accounts WHERE jid = ?", (jid,)).fetchone()
            if row is None:
                return None
            active = self.messaging_active_references(conn, jid)
            pending = row["applied_enabled"] != bool(active)
            return {"status": "pending" if pending and row["status"] not in {"error", "migrating"} else row["status"],
                    "error": row["error"], "active_devices": active}

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
            conn.execute("BEGIN IMMEDIATE")
            previous = conn.execute("SELECT state FROM devices WHERE id=?", (device_id,)).fetchone()
            if previous and previous["state"] in {"revoked", "retired"} and state in {"active", "locked"}:
                return False
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

    def _successor_tokens(self, previous_token: str) -> tuple[str, str]:
        """Derive the replacement only while the original token is available.

        Allows a short replay of a lost refresh response without storing
        plaintext credentials in SQLite. Keep the configured key stable.
        """
        def derive(purpose: bytes) -> str:
            digest = hmac.new(
                self._retry_key,
                purpose + previous_token.encode("utf-8"),
                hashlib.sha256,
            ).digest()
            return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")

        return derive(b"access:"), derive(b"refresh:")

    def rotate_refresh(
        self,
        token: str,
        access_ttl: int,
        refresh_ttl: int = 60 * 60 * 24 * 30,
    ) -> tuple[dict[str, Any], str, str, int] | None:
        digest = hash_secret(token)
        now = utcnow()
        with self._lock, self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT device_id, expires_at, revoked_at
                FROM refresh_tokens WHERE token_hash = ?
                """,
                (digest,),
            ).fetchone()
            if row is None or parse_time(row["expires_at"]) <= now:
                return None

            device_row = conn.execute(
                "SELECT state FROM devices WHERE id = ?",
                (row["device_id"],),
            ).fetchone()
            if device_row is None or device_row["state"] in {"revoked", "retired"}:
                return None

            # A retry is accepted only for the immediately preceding token,
            # during the configured grace window, while its successor is live.
            if row["revoked_at"] is not None:
                if not self._retry_key or (
                    now - parse_time(row["revoked_at"])
                ).total_seconds() > self._retry_grace_seconds:
                    return None
                access, refresh = self._successor_tokens(token)
                successor = conn.execute(
                    """
                    SELECT expires_at FROM refresh_tokens
                    WHERE token_hash = ? AND device_id = ?
                      AND revoked_at IS NULL
                    """,
                    (hash_secret(refresh), row["device_id"]),
                ).fetchone()
                access_row = conn.execute(
                    """
                    SELECT expires_at FROM access_tokens
                    WHERE token_hash = ? AND device_id = ?
                      AND revoked_at IS NULL
                    """,
                    (hash_secret(access), row["device_id"]),
                ).fetchone()
                if successor is None or access_row is None or (
                    parse_time(successor["expires_at"]) <= now
                    or parse_time(access_row["expires_at"]) <= now
                ):
                    return None
                remaining = max(
                    1, int((parse_time(access_row["expires_at"]) - now).total_seconds()),
                )
                return self.get_device(row["device_id"]), access, refresh, remaining

            if self._retry_key:
                access, refresh = self._successor_tokens(token)
            else:
                access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
            conn.execute(
                "UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?",
                (iso(now), digest),
            )
            conn.execute(
                """
                INSERT INTO access_tokens (token_hash, device_id, expires_at, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    hash_secret(access),
                    row["device_id"],
                    iso(now + timedelta(seconds=access_ttl)),
                    iso(now),
                ),
            )
            conn.execute(
                """
                INSERT INTO refresh_tokens (token_hash, device_id, expires_at, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    hash_secret(refresh),
                    row["device_id"],
                    iso(now + timedelta(seconds=refresh_ttl)),
                    iso(now),
                ),
            )
            # The old token is invalidated and its replacements are committed
            # together; on an exception SQLite rolls back the entire rotation.
            conn.commit()

        return self.get_device(row["device_id"]), access, refresh, access_ttl

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
