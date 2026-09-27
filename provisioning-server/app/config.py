import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_path: str = os.getenv(
        "PROVISIONING_DATABASE",
        "/data/provisioning.db",
    )
    admin_key: str = os.getenv("PROVISIONING_ADMIN_KEY", "")
    randy_url: str = os.getenv(
        "PROVISIONING_RANDY_URL",
        "https://randy.voicehost.io",
    )
    janus_url: str = os.getenv(
        "PROVISIONING_JANUS_URL",
        "wss://devrtc.voicehost.io:443",
    )
    access_token_ttl_seconds: int = int(
        os.getenv("ACCESS_TOKEN_TTL_SECONDS", "900"),
    )
    activation_ttl_seconds: int = int(
        os.getenv("ACTIVATION_TTL_SECONDS", "900"),
    )


settings = Settings()
