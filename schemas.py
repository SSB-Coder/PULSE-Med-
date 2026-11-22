"""Validated API inputs. Medical history is user-reported, not a diagnosis."""
from typing import Literal
from uuid import UUID
from datetime import datetime, date
from pydantic import BaseModel, ConfigDict, Field, field_validator


class MedicalHistory(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conditions: str = Field(default="", max_length=3000)
    medications: str = Field(default="", max_length=3000)
    allergies: str = Field(default="", max_length=2000)
    surgeries: str = Field(default="", max_length=2000)
    family_history: str = Field(default="", max_length=2000)
    notes: str = Field(default="", max_length=12000)


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    history: MedicalHistory


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)
    use_history: bool = False
    medical_record_id: UUID | None = None
    web_enabled: bool = False
    web_query: str = Field(default="", max_length=180)
    web_query_consent: bool = False


class MedicalRecordInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    history: MedicalHistory


class DoctorReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=64)
    reason: str = Field(default="", max_length=1000)


class WebSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^W[1-3]$")
    url: str = Field(max_length=2000)
    title: str = Field(min_length=1, max_length=200)
    publisher: str = Field(min_length=1, max_length=200)
    retrieved_at: datetime
    published_at: date | None = None
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    cited: bool = False

    @field_validator('url')
    @classmethod
    def trusted_url(cls, value):
        from web_policy import approved_url
        return approved_url(value)


class SavedMessage(ChatMessage):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=1, max_length=16000)
    doctor_matches: list[DoctorReference] = Field(default_factory=list, max_length=3)
    used_history: bool = False
    web_sources: list[WebSource] = Field(default_factory=list, max_length=3)
    web_status: Literal['off', 'used', 'limited', 'no_results', 'not_used', 'unavailable', 'rate_limited', 'busy', 'error'] = 'off'
    web_notice: str = Field(default='', max_length=500)


class ConversationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: list[SavedMessage] = Field(default_factory=list, max_length=200)
    medical_record_id: UUID | None = None
    use_history: bool = False
    revision: int = Field(default=1, ge=1, le=2147483646)
    web_enabled: bool = False
