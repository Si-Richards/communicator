from typing import Any, Literal

from pydantic import BaseModel, Field


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


class AdminActivationRequest(BaseModel):
    extension: str
    display_name: str | None = None
    expires_in: int | None = Field(default=None, ge=60, le=86400)
    connection_strategy: Literal["managed_mobile", "direct_janus"] = (
        "managed_mobile"
    )
    telephony_mode: Literal["randy_managed", "direct_janus"] = "randy_managed"
    randy_url: str | None = None
    janus_url: str | None = None
    sip_username: str | None = None
    sip_password: str | None = None
    sip_realm: str | None = None
    sip_proxy: str | None = None
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
            "allow_manual_fallback": True,
            "minimum_app_build": 23,
            "force_update": False,
        },
    )


class AdminDeviceStateRequest(BaseModel):
    state: Literal["active", "locked", "revoked", "retired"]
