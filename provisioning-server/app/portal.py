"""Restricted, server-rendered entry and same-origin admin portal API.

This is the first single-administrator rollout. Individual accounts and MFA
must be added before widening access beyond the VoiceHost management VPN.
"""
import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, Field

from .models import AdminActivationRequest, AdminDeviceStateRequest, AdminHousekeepingRequest

STATIC = Path(__file__).parent / "static"
COOKIE = "vh_portal"
SESSION_AGE = 60 * 60 * 8


class LoginBody(BaseModel):
    password: str = Field(min_length=1, max_length=4096)


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, rounds, salt, expected = encoded.split("$")
        if scheme != "pbkdf2_sha256" or not 200000 <= int(rounds) <= 2000000:
            return False
        computed = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt), int(rounds)
        )
        return hmac.compare_digest(computed, bytes.fromhex(expected))
    except (ValueError, TypeError):
        return False


def make_router(store, settings) -> APIRouter:
    router = APIRouter()
    signer = URLSafeTimedSerializer(settings.portal_secret, salt="voicehost-portal-v1") if settings.portal_secret else None
    failures = defaultdict(list)
    failure_lock = threading.Lock()

    def configured() -> bool:
        return bool(signer and settings.portal_password_hash and len(settings.portal_secret) >= 32)

    def session(request: Request) -> dict:
        if not configured():
            raise HTTPException(503, "Administrator login is not configured.")
        try:
            data = signer.loads(request.cookies.get(COOKIE, ""), max_age=SESSION_AGE)
            if data.get("role") != "administrator" or not data.get("csrf"):
                raise BadSignature("Invalid session")
            return data
        except (BadSignature, SignatureExpired):
            raise HTTPException(401, "Administrator login required.")

    def csrf_check(request: Request, data: dict) -> None:
        token = request.headers.get("X-CSRF-Token", "")
        if not token or not hmac.compare_digest(token, data["csrf"]):
            raise HTTPException(403, "Invalid CSRF token.")
        origin = request.headers.get("origin")
        if origin and origin.rstrip("/") != settings.portal_origin.rstrip("/"):
            raise HTTPException(403, "Untrusted origin.")

    def protect(response: Response) -> Response:
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'none'; base-uri 'none'; form-action 'self'; "
            "frame-ancestors 'none'; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; img-src 'self' data:"
        )
        return response

    @router.get("/")
    def root():
        return RedirectResponse("/portal", status_code=302)

    @router.get("/portal")
    def portal(request: Request):
        try:
            session(request)
        except HTTPException as exc:
            if exc.status_code == 401:
                return RedirectResponse("/portal/login", status_code=303)
            raise
        return protect(FileResponse(STATIC / "index.html", media_type="text/html"))

    @router.get("/portal/login")
    def login_page(request: Request):
        if not configured():
            return protect(JSONResponse({"error": "Configure portal password hash and session secret in .env."}, status_code=503))
        try:
            session(request)
            return RedirectResponse("/portal", status_code=303)
        except HTTPException:
            return protect(FileResponse(STATIC / "login.html", media_type="text/html"))

    @router.get("/portal/assets/{asset}")
    def assets(asset: str):
        if asset not in {"app.js", "style.css"}:
            raise HTTPException(404)
        return protect(FileResponse(STATIC / asset))

    @router.post("/portal/api/login")
    def login(body: LoginBody, request: Request):
        if not configured():
            raise HTTPException(503, "Administrator login is not configured.")
        # Enforce a small lockout per remote address; the management VPN and
        # upstream rate limits remain the primary perimeter.
        origin = request.headers.get("origin")
        if origin and origin.rstrip("/") != settings.portal_origin.rstrip("/"):
            raise HTTPException(403, "Untrusted origin.")
        address = request.client.host if request.client else "unknown"
        now = time.monotonic()
        with failure_lock:
            attempts = [v for v in failures[address] if now - v < 900]
            failures[address] = attempts
            blocked = len(attempts) >= 5
        if blocked:
            raise HTTPException(429, "Too many attempts. Try again later.")
        if not verify_password(body.password, settings.portal_password_hash):
            with failure_lock:
                failures[address].append(now)
            store.audit("portal_login_failed", detail={"source": address})
            raise HTTPException(401, "Invalid credentials.")
        with failure_lock:
            failures.pop(address, None)
        data = {"role": "administrator", "csrf": secrets.token_urlsafe(32)}
        result = protect(JSONResponse({"ok": True}))
        result.set_cookie(
            COOKIE, signer.dumps(data), httponly=True, secure=True,
            samesite="strict", max_age=SESSION_AGE, path="/portal",
        )
        store.audit("portal_login", detail={"source": address})
        return result

    @router.get("/portal/api/session")
    def whoami(request: Request):
        data = session(request)
        return protect(JSONResponse({"role": data["role"], "csrf": data["csrf"]}))

    @router.post("/portal/api/logout")
    def logout(request: Request):
        data = session(request)
        csrf_check(request, data)
        result = protect(JSONResponse({"ok": True}))
        result.delete_cookie(COOKIE, path="/portal")
        store.audit("portal_logout")
        return result

    @router.get("/portal/api/overview")
    def overview(request: Request):
        session(request)
        with store._connect() as conn:
            states = conn.execute("SELECT state, COUNT(*) AS n FROM devices GROUP BY state").fetchall()
            count = conn.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
            waiting = conn.execute(
                "SELECT COUNT(*) FROM activations WHERE consumed_at IS NULL AND expires_at > ?",
                (datetime.now(UTC).isoformat().replace("+00:00", "Z"),),
            ).fetchone()[0]
        return protect(JSONResponse({
            "devices": count,
            "by_state": {row["state"]: row["n"] for row in states},
            "pending_activations": waiting,
        }))

    @router.get("/portal/api/devices")
    def devices(request: Request, limit: int = 50, offset: int = 0,
                state: str | None = None, query: str | None = None):
        session(request)
        if not 1 <= limit <= 200 or offset < 0 or (query and len(query) > 200):
            raise HTTPException(422, "Invalid inventory query.")
        if state and state not in {"pending", "active", "locked", "revoked", "retired"}:
            raise HTTPException(422, "Invalid device state.")
        return protect(JSONResponse(store.list_devices(limit=limit, offset=offset, state=state, query=query)))

    @router.post("/portal/api/devices/{device_id}/state")
    def device_state(device_id: str, body: AdminDeviceStateRequest, request: Request):
        data = session(request)
        csrf_check(request, data)
        previous = store.get_device(device_id)
        if previous is None:
            raise HTTPException(404, "Device not found.")
        if previous["state"] in {"revoked", "retired"} and body.state in {"active", "locked"}:
            raise HTTPException(409, "Revoked or retired devices must be re-provisioned.")
        if not store.set_device_state(device_id, body.state):
            raise HTTPException(404, "Device not found.")
        store.audit("portal_device_state_changed", device_id, {"from": previous["state"], "to": body.state})
        return protect(JSONResponse({"device_id": device_id, "state": body.state}))

    @router.post("/portal/api/activations")
    def activation(body: AdminActivationRequest, request: Request):
        data = session(request)
        csrf_check(request, data)
        payload = body.model_dump()
        payload["randy_url"] = payload.get("randy_url") or settings.randy_url
        payload["janus_url"] = payload.get("janus_url") or settings.janus_url
        payload["version"] = 1
        ident, code, expires = store.create_activation(payload, body.expires_in or settings.activation_ttl_seconds)
        store.audit("portal_activation_created", detail={"activation_id": ident})
        return protect(JSONResponse({
            "id": ident, "code": code, "expires_at": expires,
            "qr_uri": "voicehost://provision/" + code,
        }, status_code=201))

    @router.post("/portal/api/maintenance/housekeeping")
    def housekeeping(body: AdminHousekeepingRequest, request: Request):
        data = session(request)
        csrf_check(request, data)
        result = store.housekeeping(body.retention_days, body.dry_run)
        store.audit("portal_housekeeping", detail=result)
        return protect(JSONResponse(result))

    return router
