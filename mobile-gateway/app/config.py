from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    gateway_api_key: str
    device_data_key: str
    database_path: Path = Path('/data/mobile-gateway.db')
    janus_url: str = 'wss://devrtc.voicehost.io:443'
    janus_api_secret: str = ''
    apns_team_id: str = ''
    apns_key_id: str = ''
    apns_bundle_id: str = ''
    apns_key_path: Path = Path('/run/secrets/AuthKey.p8')
    apns_sandbox: bool = True


settings = Settings()
