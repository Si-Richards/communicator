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
        os.getenv('REFRESH_RETRY_GRACE_SECONDS', '30')
    )
    access_token_ttl_seconds: int = int(
        os.getenv("ACCESS_TOKEN_TTL_SECONDS", "900"),
    )
    activation_ttl_seconds: int = int(
        os.getenv("ACTIVATION_TTL_SECONDS", "900"),
    )


settings = Settings()
