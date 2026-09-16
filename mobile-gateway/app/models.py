from dataclasses import dataclass
from pydantic import BaseModel, Field


class DeviceRegistration(BaseModel):
    device_id: str = Field(min_length=8, max_length=200)
    platform: str = 'ios'
    push_token: str = Field(min_length=16, max_length=512)
    sip_username: str = Field(min_length=1, max_length=200)
    sip_password: str = Field(min_length=1, max_length=512)
    sip_realm: str = Field(min_length=1, max_length=255)
    sip_proxy: str | None = None
    nickname: str = ''
    dnd: bool = False


class AnswerRequest(BaseModel):
    sdp: str = Field(min_length=1)


class CandidateRequest(BaseModel):
    candidate: str | None = None
    sdpMid: str | None = None
    sdpMLineIndex: int | None = None
    completed: bool = False


@dataclass(slots=True)
class DeviceRecord:
    device_id: str
    platform: str
    push_token: str
    sip_username: str
    sip_password: str
    sip_realm: str
    sip_proxy: str | None
    nickname: str
    dnd: bool
