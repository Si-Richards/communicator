import hmac
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from .config import settings
from .models import (
    messaging_configuration,
    ActivationRequest,
    AdminActivationRequest,
    AdminDeviceConfigurationRequest,
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
    version="0.3.0",
)
@app.middleware("http")
async def prevent_credential_caching(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/v1/"):
        response.headers["Cache-Control"] = "no-store"
    return response


store = Store(
    settings.database_path,
    retry_key=settings.refresh_retry_key,
    retry_grace_seconds=settings.refresh_retry_grace_seconds,
)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    # Pydantic's default response includes the submitted input (and secrets).
    return JSONResponse(status_code=422, content={"error": {
        "code": "invalid_request", "message": "Check the submitted configuration.",
        "fields": [list(item["loc"]) for item in exc.errors()],
    }}, headers={"Cache-Control": "no-store"})


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
    if (not settings.admin_key or not x_admin_key
            or not hmac.compare_digest(x_admin_key, settings.admin_key)):
        raise error("admin_unauthorized", "Administrator credential required.", 401)


LDAP_HOST = "ldap.sipconvergence.co.uk"
LDAP_PORT = 389
LDAP_SUFFIX = "dc=sipconvergence,dc=co,dc=uk"
LDAP_NAME_FILTER = (
    "(&(|(sn=%*)(givenName=%*))"
    "(|(telephoneNumber=*)(mobile=*)(vhVoIPPhone=*)(vhVoIPExt=*)))"
)
LDAP_NUMBER_FILTER = (
    "(|(telephoneNumber=%*)(mobile=%*)(vhVoIPPhone=%*)(vhVoIPExt=%*))"
)
LDAP_NAME_ATTRIBUTES = ["cn"]
LDAP_NUMBER_ATTRIBUTES = [
    "telephoneNumber",
    "mobile",
    "vhVoIPPhone",
    "vhVoIPExt",
]


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

    ldap_enabled = bool(source.get("ldap_enabled", False))
    ldap_ou = str(source.get("ldap_ou") or "").strip()
    ldap_uid = str(source.get("ldap_uid") or "").strip()
    ldap_password = source.get("ldap_password")

    ldap_config = {
        "enabled": ldap_enabled,
        "host": LDAP_HOST,
        "port": LDAP_PORT,
        "tls": False,
        "initial_query": False,
        "sort_mode": "client",
        "name_filter": LDAP_NAME_FILTER,
        "number_filter": LDAP_NUMBER_FILTER,
        "name_filter_during_call": LDAP_NAME_FILTER,
        "number_filter_during_call": LDAP_NUMBER_FILTER,
        "name_attributes": LDAP_NAME_ATTRIBUTES,
        "number_attributes": LDAP_NUMBER_ATTRIBUTES,
        "display_name": "%cn",
        "country_code": "",
        "area_code": "",
    }
    if ldap_enabled:
        ldap_config.update({
            "ou": ldap_ou,
            "uid": ldap_uid,
            "base_dn": f"ou={ldap_ou},{LDAP_SUFFIX}",
            "bind_dn": f"uid={ldap_uid},ou=auth,ou={ldap_ou},{LDAP_SUFFIX}",
            "password": ldap_password,
        })
    directory = {"ldap": ldap_config}

    branding_name = str(source.get("branding_name") or "VoiceHost").strip()
    if not branding_name:
        branding_name = "VoiceHost"

    return {
        "version": int(source.get("version", 1)),
        "branding": {
            "name": branding_name,
        },
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
        "directory": directory,
        "messaging": messaging_configuration(
            source.get("messaging_enabled", False), source.get("messaging_jid"),
            source.get("messaging_password"), source.get("messaging_websocket")),
        "features": source.get("features", {}),
        "policy": {**source.get("policy", {}), "allow_manual_fallback": False, "allow_settings_edit": False},
    }


def update_managed_configuration(
    device_id: str,
    request: AdminDeviceConfigurationRequest,
) -> dict:
    device = store.get_device(device_id)
    if device is None:
        raise error("device_not_found", "Device was not found.", 404)
    if device["state"] in {"revoked", "retired"}:
        raise error(
            "device_inactive",
            "Revoked or retired devices must be re-provisioned.",
            409,
        )

    current = dict(device["config"])
    current_device = dict(current.get("device", {}))
    current_branding = dict(current.get("branding", {}))
    current_services = dict(current.get("services", {}))
    current_telephony = dict(current.get("telephony", {}))
    current_sip = dict(current_telephony.get("sip", {}))
    current_directory = dict(current.get("directory", {}))
    current_ldap = dict(current_directory.get("ldap", {}))

    messaging = dict(current.get("messaging", {}))
    messaging_enabled = (request.messaging_enabled if request.messaging_enabled is not None
                         else bool(messaging.get("enabled", False)))
    messaging_jid = (request.messaging_jid if request.messaging_jid is not None
                     else messaging.get("jid") or "").strip().lower()
    messaging_websocket = (request.messaging_websocket if request.messaging_websocket is not None
                           else messaging.get("websocket"))
    # A new identity or endpoint must never inherit another account's secret.
    same_identity = (messaging_jid == messaging.get("jid")
                     and (messaging_websocket or "wss://ejabberd.voicehost.io/websocket")
                     == (messaging.get("websocket") or "wss://ejabberd.voicehost.io/websocket"))
    messaging_password = request.messaging_password
    if not messaging_password and same_identity:
        messaging_password = messaging.get("password")
    try:
        messaging_configuration(messaging_enabled, messaging_jid,
                                messaging_password, messaging_websocket)
    except ValueError as exc:
        raise error("messaging_configuration_incomplete", str(exc), 422)

    password = request.sip_password
    if password is None or password == "":
        password = current_sip.get("password")

    ldap_password = request.ldap_password
    if ldap_password is None or ldap_password == "":
        ldap_password = current_ldap.get("password")
    ldap_enabled = (
        request.ldap_enabled
        if request.ldap_enabled is not None
        else bool(current_ldap.get("enabled", False))
    )
    ldap_ou = (
        request.ldap_ou.strip()
        if request.ldap_ou and request.ldap_ou.strip()
        else str(current_ldap.get("ou") or "").strip()
    )
    ldap_uid = (
        request.ldap_uid.strip()
        if request.ldap_uid and request.ldap_uid.strip()
        else str(current_ldap.get("uid") or "").strip()
    )
    if ldap_enabled and (not ldap_ou or not ldap_uid or not ldap_password):
        raise error(
            "ldap_configuration_incomplete",
            "LDAP requires OU, UID and password when enabled.",
            422,
        )

    source = {
        "version": int(device["configuration_version"]) + 1,
        "extension": request.extension.strip(),
        "display_name": (
            request.display_name.strip()
            if request.display_name and request.display_name.strip()
            else current_device.get("display_name") or request.extension.strip()
        ),
        "branding_name": (
            request.branding_name.strip()
            if request.branding_name and request.branding_name.strip()
            else str(current_branding.get("name") or "VoiceHost").strip()
        ),
        "connection_strategy": request.connection_strategy,
        "telephony_mode": request.telephony_mode,
        "randy_url": (
            request.randy_url.strip()
            if request.randy_url and request.randy_url.strip()
            else current_services.get("randy_url") or settings.randy_url
        ),
        "janus_url": (
            request.janus_url.strip()
            if request.janus_url and request.janus_url.strip()
            else current_telephony.get("janus_url")
            or current_services.get("janus_url")
            or settings.janus_url
        ),
        "janus_api_secret": (
            request.janus_api_secret
            if request.janus_api_secret is not None
            else current_telephony.get("janus_api_secret")
        ),
        "sip_username": (
            request.sip_username.strip()
            if request.sip_username and request.sip_username.strip()
            else current_sip.get("username")
        ),
        "sip_password": password,
        "sip_realm": (
            request.sip_realm.strip()
            if request.sip_realm and request.sip_realm.strip()
            else current_sip.get("realm")
        ),
        "sip_proxy": (
            request.sip_proxy.strip()
            if request.sip_proxy and request.sip_proxy.strip()
            else None
        ),
        "messaging_enabled": messaging_enabled,
        "messaging_jid": messaging_jid,
        "messaging_password": messaging_password,
        "messaging_websocket": messaging_websocket,
        "ldap_enabled": ldap_enabled,
        "ldap_ou": ldap_ou,
        "ldap_uid": ldap_uid,
        "ldap_password": ldap_password,
        "features": dict(current.get("features", {})),
        "policy": dict(current.get("policy", {})),
    }
    config = build_configuration(source, state=device["state"])
    updated = store.update_device_configuration(device_id, config)
    if updated is None:
        raise error("device_not_found", "Device was not found.", 404)
    store.audit(
        "device_configuration_updated",
        device_id,
        {"configuration_version": updated["configuration_version"]},
    )
    return updated




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


@app.put("/api/v1/admin/devices/{device_id}/configuration")
def admin_update_device_configuration(
    device_id: str,
    request: AdminDeviceConfigurationRequest,
    _: Annotated[None, Depends(admin_auth)],
) -> dict:
    updated = update_managed_configuration(device_id, request)
    return {
        "device_id": device_id,
        "configuration_version": updated["configuration_version"],
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
    config["policy"] = {
        **config.get("policy", {}),
        "allow_manual_fallback": False,
        "allow_settings_edit": False,
    }
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
    # A signed-out installation must be eligible for a new activation code.
    # Retiring revokes both token families in the same transaction.
    store.set_device_state(device["id"], "retired")
    store.audit("device_logout", device["id"], {"reason": request.reason})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# Separate ASGI applications: public port 443 never registers administrative
# routes. Admin is served by a separate Uvicorn process on private port 8082.
admin_app = FastAPI(
    title="VoiceHost Provisioning Administration",
    version="0.3.0",
)
admin_app.middleware("http")(prevent_credential_caching)
admin_app.add_exception_handler(HTTPException, http_exception_handler)
admin_app.add_exception_handler(RequestValidationError, validation_exception_handler)
admin_routes = [
    route for route in app.router.routes
    if getattr(route, "path", "").startswith("/api/v1/admin/")
]
admin_app.router.routes.extend(admin_routes)
app.router.routes = [
    route for route in app.router.routes if route not in admin_routes
]


@admin_app.get("/health")
def admin_health() -> dict:
    return {"status": "ok"}

# The portal exists only in the administration ASGI application.
from .portal import make_router
admin_app.include_router(make_router(store, settings, update_managed_configuration))
