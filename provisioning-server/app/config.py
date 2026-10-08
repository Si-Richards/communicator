import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_path: str = os.getenv(
        "PROVISIONING_DATABASE",
        "/data/provisioning.db",
    )
    admin_key: str = os.getenv("PROVISIONING_ADMIN_KEY", "")
    portal_secret: str = os.getenv("PROVISIONING_PORTAL_SECRET", "")
    portal_password_hash: str = os.getenv("PROVISIONING_PORTAL_PASSWORD_HASH", "")
    portal_origin: str = os.getenv("PROVISIONING_PORTAL_ORIGIN", "https://provisioning.softphone.voicehost.io:8443")
    randy_url: str = os.getenv(
        "PROVISIONING_RANDY_URL",
        "https://randy.voicehost.io",
    )
    janus_url: str = os.getenv(
        "PROVISIONING_JANUS_URL",
        "wss://devrtc.voicehost.io:443",
    )
    refresh_retry_key: str = os.getenv('PROVISIONING_REFRESH_RETRY_KEY', '')
    refresh_retry_grace_seconds: int = int(
        os.getenv('REFRESH_RETRY_GRACE_SECONDS', '86400')
    )
    access_token_ttl_seconds: int = int(
        os.getenv("ACCESS_TOKEN_TTL_SECONDS", "900"),
    )
    activation_ttl_seconds: int = int(
        os.getenv("ACTIVATION_TTL_SECONDS", "900"),
    )
    ejabberd_management_enabled: bool = os.getenv("EJABBERD_MANAGEMENT_ENABLED", "false").lower() == "true"
    ejabberd_host: str = os.getenv("EJABBERD_HOST", "ejabberd.voicehost.io")
    ejabberd_websocket: str = os.getenv("EJABBERD_WEBSOCKET", "wss://ejabberd.voicehost.io/websocket")
    ejabberd_api_url: str = os.getenv("EJABBERD_API_URL", "")
    ejabberd_api_username: str = os.getenv("EJABBERD_API_USERNAME", "")
    ejabberd_api_password: str = os.getenv("EJABBERD_API_PASSWORD", "")

    messaging_push_enabled: bool = os.getenv("MESSAGING_PUSH_ENABLED", "false").lower() == "true"
    apns_team_id: str = os.getenv("MESSAGING_APNS_TEAM_ID", "")
    apns_key_id: str = os.getenv("MESSAGING_APNS_KEY_ID", "")
    apns_bundle_id: str = os.getenv("MESSAGING_APNS_BUNDLE_ID", "")
    apns_key_path: str = os.getenv("MESSAGING_APNS_KEY_PATH", "/run/secrets/messaging-apns.p8")


settings = Settings()
