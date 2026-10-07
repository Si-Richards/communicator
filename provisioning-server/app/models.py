import re
from urllib.parse import urlsplit
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


Platform = Literal["ios", "android", "windows", "macos"]
DeviceType = Literal["mobile", "desktop", "tablet"]
DeviceState = Literal["pending", "active", "locked", "revoked", "retired"]


class PushBundle(BaseModel):
    voip_token: str | None = None
    notification_token: str | None = None
    environment: Literal["sandbox", "production"] | None = None


class DeviceDescriptor(BaseModel):
    installation_id: str = Field(min_length=8, max_length=200)
    platform: Platform
    device_type: DeviceType
    device_name: str | None = Field(default=None, max_length=200)
    app_version: str
    app_build: int = Field(ge=1)
    os_version: str | None = None


class ActivationRequest(BaseModel):
    code: str = Field(min_length=4, max_length=64)
    device: DeviceDescriptor
    push: PushBundle | None = None


class RefreshRequest(BaseModel):
    refresh_token: str


class CheckInRequest(BaseModel):
    configuration_version: int = Field(ge=0)
    app_version: str
    app_build: int = Field(ge=1)
    os_version: str | None = None
    push: PushBundle | None = None


class PushToken(BaseModel):
    type: Literal["apns_voip", "apns_notification", "fcm"]
    token: str
    environment: Literal["sandbox", "production"] | None = None


class PushTokenUpdateRequest(BaseModel):
    tokens: list[PushToken] = Field(min_length=1)


class LogoutRequest(BaseModel):
    reason: Literal["user_requested", "reprovision", "other"] = "user_requested"


MESSAGING_WEBSOCKET = "wss://ejabberd.voicehost.io/websocket"


def messaging_configuration(enabled, jid, password, websocket):
    if not enabled:
        return {"enabled": False}
    jid = (jid or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9._+*\-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", jid):
        raise ValueError("Messaging requires a bare account JID.")
    try:
        uri = urlsplit(websocket or MESSAGING_WEBSOCKET)
        if uri.port is not None and not 1 <= uri.port <= 65535:
            raise ValueError("Invalid port")
    except ValueError:
        raise ValueError("Messaging requires a valid secure WebSocket URL.") from None
    if (uri.scheme != "wss" or not uri.hostname or any(c.isspace() for c in websocket or "")
            or uri.username is not None
            or uri.password is not None or uri.query or uri.fragment):
        raise ValueError("Messaging requires a secure WebSocket URL without credentials.")
    if not password or "\x00" in password:
        raise ValueError("Messaging requires its own account password.")
    return {"enabled": True, "jid": jid, "password": password,
            "websocket": websocket or MESSAGING_WEBSOCKET}


def automatic_messaging_configuration(sip_username, host, websocket):
    username = (sip_username or "").strip().lower()
    if not username or len(username) > 240:
        raise ValueError("Automatic messaging requires the full SIP username.")
    # Reuse endpoint/JID validation without introducing an alternate identity.
    result = messaging_configuration(True, f"{username}@{host}", "validation-only", websocket)
    result.pop("password")
    result["managed"] = True
    return result


class AdminActivationRequest(BaseModel):
    extension: str
    display_name: str | None = None
    branding_name: str = Field(default="VoiceHost", min_length=1, max_length=80)
    expires_in: int | None = Field(default=None, ge=60, le=86400)
    connection_strategy: Literal["managed_mobile", "direct_janus"] = (
        "managed_mobile"
    )
    telephony_mode: Literal["randy_managed", "direct_janus"] = "randy_managed"
    randy_url: str | None = None
    janus_url: str | None = None
    janus_api_secret: str | None = None
    sip_username: str | None = None
    sip_password: str | None = None
    sip_realm: str | None = None
    sip_proxy: str | None = None
    messaging_enabled: bool = False
    messaging_managed: bool = False
    messaging_jid: str | None = Field(default=None, max_length=320)
    messaging_password: str | None = Field(default=None, max_length=512)
    messaging_websocket: str | None = Field(default=None, max_length=2048)
    ldap_enabled: bool = False
    ldap_ou: str | None = Field(default=None, max_length=120)
    ldap_uid: str | None = Field(default=None, max_length=200)
    ldap_password: str | None = Field(default=None, max_length=512)
    features: dict[str, bool] = Field(
        default_factory=lambda: {
            "video": True,
            "blind_transfer": True,
            "attended_transfer": True,
            "voicemail": True,
            "messaging": True,
            "contacts": True,
        },
    )
    policy: dict[str, Any] = Field(
        default_factory=lambda: {
            "allow_settings_edit": False,
            "allow_manual_fallback": False,
            "minimum_app_build": 23,
            "force_update": False,
        },
    )

    @model_validator(mode="after")
    def validate_ldap(self):
        if self.messaging_enabled and self.messaging_managed:
            automatic_messaging_configuration(self.sip_username, "ejabberd.voicehost.io", MESSAGING_WEBSOCKET)
            if self.messaging_jid or self.messaging_password or self.messaging_websocket:
                raise ValueError("Automatic messaging uses server-managed credentials and endpoint.")
        else:
            messaging_configuration(self.messaging_enabled, self.messaging_jid,
                                    self.messaging_password, self.messaging_websocket)
        if self.ldap_enabled and not (
            (self.ldap_ou or "").strip()
            and (self.ldap_uid or "").strip()
            and self.ldap_password
        ):
            raise ValueError("LDAP requires OU, UID and password when enabled.")
        return self


class AdminDeviceConfigurationRequest(BaseModel):
    extension: str = Field(min_length=1, max_length=80)
    display_name: str | None = Field(default=None, max_length=120)
    branding_name: str | None = Field(default=None, min_length=1, max_length=80)
    connection_strategy: Literal["managed_mobile", "direct_janus"] = (
        "managed_mobile"
    )
    telephony_mode: Literal["randy_managed", "direct_janus"] = "randy_managed"
    randy_url: str | None = None
    janus_url: str | None = None
    janus_api_secret: str | None = None
    sip_username: str | None = None
    # Null/empty means retain the existing managed SIP secret.
    sip_password: str | None = None
    sip_realm: str | None = None
    sip_proxy: str | None = None
    messaging_enabled: bool | None = None
    messaging_managed: bool | None = None
    messaging_jid: str | None = Field(default=None, max_length=320)
    messaging_password: str | None = Field(default=None, max_length=512)
    messaging_websocket: str | None = Field(default=None, max_length=2048)
    ldap_enabled: bool | None = None
    ldap_ou: str | None = Field(default=None, max_length=120)
    ldap_uid: str | None = Field(default=None, max_length=200)
    # Null/empty means retain the existing managed LDAP secret.
    ldap_password: str | None = Field(default=None, max_length=512)


class AdminDeviceStateRequest(BaseModel):
    state: Literal["active", "locked", "revoked", "retired"]

class AdminHousekeepingRequest(BaseModel):
    retention_days: int = Field(default=90, ge=1, le=3650)
    dry_run: bool = True
