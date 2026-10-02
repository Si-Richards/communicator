from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse

from .config import settings
from .models import (
    ActivationRequest,
    AdminActivationRequest,
    AdminDeviceStateRequest,
    AdminHousekeepingRequest,
    CheckInRequest,
    LogoutRequest,
    PushTokenUpdateRequest,
    RefreshRequest,
)
from .store import Store


app = FastAPI(
    title="VoiceHost Provisioning Service",
    version="0.2.0",
)
store = Store(
    settings.database_path,
    retry_key=settings.refresh_retry_key,
    retry_grace_seconds=settings.refresh_retry_grace_seconds,
)


def error(code: str, message: str, status_code: int) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(
    request: Request,
    exc: HTTPException,
) -> JSONResponse:
    detail = exc.detail if isinstance(exc.detail, dict) else {
        "code": "http_error",
        "message": str(exc.detail),
    }
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": detail},
        headers=exc.headers,
    )


def authenticated_device(
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise error("unauthorized", "Device credential required.", 401)
    token = authorization.split(" ", 1)[1].strip()
    device = store.authenticate_access(token)
    if device is None:
        raise error("unauthorized", "Device credential is invalid or expired.", 401)
    if device["state"] in {"revoked", "retired"}:
        raise error("device_revoked", "This device is no longer authorised.", 403)
    device["_access_token"] = token
    return device


def bearer_device(
    device: Annotated[dict, Depends(authenticated_device)],
) -> dict:
    if device["state"] == "locked":
        raise error("device_locked", "This device is locked.", 423)
    return device


def admin_auth(
    x_admin_key: Annotated[str | None, Header(alias="X-Admin-Key")] = None,
) -> None:
    if not settings.admin_key or x_admin_key != settings.admin_key:
        raise error("admin_unauthorized", "Administrator credential required.", 401)


def build_configuration(source: dict, state: str = "active") -> dict:
    strategy = source.get("connection_strategy", "managed_mobile")
    telephony_mode = source.get("telephony_mode", "randy_managed")
    telephony = {
        "mode": telephony_mode,
        "extension": source["extension"],
    }
    if source.get("janus_url"):
        telephony["janus_url"] = source["janus_url"]
    if source.get("janus_api_secret"):
        telephony["janus_api_secret"] = source["janus_api_secret"]

    if source.get("sip_username"):
        telephony["sip"] = {
            "username": source.get("sip_username"),
            "password": source.get("sip_password"),
            "realm": source.get("sip_realm"),
            "proxy": source.get("sip_proxy"),
        }

    return {
        "version": int(source.get("version", 1)),
        "device": {
            "display_name": source.get("display_name") or source["extension"],
            "state": state,
        },
        "connection_strategy": strategy,
        "services": {
            "randy_url": source.get("randy_url") or settings.randy_url,
            "janus_url": source.get("janus_url") or settings.janus_url,
        },
        "telephony": telephony,
        "features": source.get("features", {}),
        "policy": {**source.get("policy", {}), "allow_manual_fallback": False, "allow_settings_edit": False},
    }


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/v1/admin/activations")
def create_activation(
    request: AdminActivationRequest,
    _: Annotated[None, Depends(admin_auth)],
) -> dict:
    payload = request.model_dump()
    payload["randy_url"] = payload.get("randy_url") or settings.randy_url
    payload["janus_url"] = payload.get("janus_url") or settings.janus_url
    payload["version"] = 1
    ttl = request.expires_in or settings.activation_ttl_seconds
    activation_id, code, expires_at = store.create_activation(payload, ttl)
    store.audit("activation_created", detail={"activation_id": activation_id})
    return {
        "id": activation_id,
        "code": code,
        "expires_at": expires_at,
        "qr_uri": f"voicehost://provision/{code}",
    }


@app.post("/api/v1/admin/devices/{device_id}/state")
def change_device_state(
    device_id: str,
    request: AdminDeviceStateRequest,
    _: Annotated[None, Depends(admin_auth)],
) -> dict:
    if not store.set_device_state(device_id, request.state):
        raise error("device_not_found", "Device was not found.", 404)
    store.audit(
        "device_state_changed",
        device_id,
        {"state": request.state},
    )
    return {"device_id": device_id, "state": request.state}


@app.get("/api/v1/admin/devices")
def admin_list_devices(
    _: Annotated[None, Depends(admin_auth)],
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    state: str | None = Query(default=None, pattern="^(pending|active|locked|revoked|retired)$"),
    query: str | None = Query(default=None, max_length=200),
) -> dict:
    return store.list_devices(limit=limit, offset=offset, state=state, query=query)


@app.post("/api/v1/admin/maintenance/housekeeping")
def admin_housekeeping(
    request: AdminHousekeepingRequest,
    _: Annotated[None, Depends(admin_auth)],
) -> dict:
    result = store.housekeeping(retention_days=request.retention_days, dry_run=request.dry_run)
    store.audit("housekeeping_run", detail=result)
    return result


@app.get("/api/v1/admin/devices/{device_id}")
def admin_get_device(
    device_id: str,
    _: Annotated[None, Depends(admin_auth)],
) -> dict:
    device = store.get_device(device_id)
    if device is None:
        raise error("device_not_found", "Device was not found.", 404)
    device.pop("config", None)
    device.pop("push", None)
    return device


@app.post("/api/v1/device/activate", status_code=status.HTTP_201_CREATED)
def activate(request: ActivationRequest, response: Response) -> dict:
    result, failure = store.activate_device(
        request.code,
        request.device.model_dump(),
        build_configuration,
        request.push.model_dump(exclude_none=True) if request.push else None,
        settings.access_token_ttl_seconds,
    )
    if failure:
        if failure == "installation_already_registered":
            raise error(
                failure,
                "This installation is already registered. An administrator must retire "
                "or revoke the previous registration before re-provisioning.",
                409,
            )
        raise error(
            "activation_code_invalid",
            "The activation code is invalid, expired or already used.",
            409,
        )
    device_id, access, refresh_token, ttl, config = result
    response.headers["Cache-Control"] = "no-store"
    return {
        "device_id": device_id,
        "access_token": access,
        "refresh_token": refresh_token,
        "expires_in": ttl,
        "configuration_version": int(config.get("version", 1)),
        "configuration": config,
    }


@app.post("/api/v1/device/token/refresh")
def refresh(request: RefreshRequest, response: Response) -> dict:
    result = store.rotate_refresh(
        request.refresh_token,
        settings.access_token_ttl_seconds,
    )
    if result is None:
        store.audit('token_refresh_rejected', detail={'reason': 'invalid_expired_or_revoked'})
        raise error(
            "refresh_token_invalid",
            "The refresh credential is invalid or expired.",
            401,
        )
    device, access, refresh_token, ttl = result
    store.audit("token_refreshed", device["id"])
    response.headers["Cache-Control"] = "no-store"
    return {
        "access_token": access,
        "refresh_token": refresh_token,
        "expires_in": ttl,
    }


@app.post("/api/v1/device/check-in")
def check_in(
    request: CheckInRequest,
    device: Annotated[dict, Depends(authenticated_device)],
) -> dict:
    updated = store.update_checkin(device["id"], request.model_dump())
    if updated is None:
        raise error("device_not_found", "Device was not found.", 404)

    config_changed = (
        request.configuration_version != updated["configuration_version"]
    )
    policy = updated["config"].get("policy", {})
    store.audit(
        "device_checkin",
        updated["id"],
        {"app_build": request.app_build},
    )
    return {
        "state": updated["state"],
        "configuration_version": updated["configuration_version"],
        "configuration_changed": config_changed,
        "minimum_app_build": policy.get("minimum_app_build"),
        "force_update": bool(policy.get("force_update", False)),
        "actions": ["refresh_configuration"] if config_changed else [],
    }


@app.get("/api/v1/device/configuration")
def configuration(
    device: Annotated[dict, Depends(bearer_device)],
) -> dict:
    config = dict(device["config"])
    config["device"] = dict(config.get("device", {}))
    config["device"]["state"] = device["state"]
    config["version"] = device["configuration_version"]
    return config


@app.post("/api/v1/device/push-tokens", status_code=status.HTTP_204_NO_CONTENT)
def update_push_tokens(
    request: PushTokenUpdateRequest,
    device: Annotated[dict, Depends(bearer_device)],
) -> Response:
    store.update_push(
        device["id"],
        [item.model_dump(exclude_none=True) for item in request.tokens],
    )
    store.audit("push_tokens_updated", device["id"])
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/api/v1/device/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: LogoutRequest,
    device: Annotated[dict, Depends(bearer_device)],
) -> Response:
    store.revoke_device_tokens(device["id"])
    store.audit("device_logout", device["id"], {"reason": request.reason})
    return Response(status_code=status.HTTP_204_NO_CONTENT)
