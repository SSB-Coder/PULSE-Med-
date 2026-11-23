"""Validated API inputs. Medical history is user-reported, not a diagnosis."""
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field


class MedicalHistory(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conditions: str = Field(default="", max_length=3000)
    medications: str = Field(default="", max_length=3000)
    allergies: str = Field(default="", max_length=2000)
    surgeries: str = Field(default="", max_length=2000)
    family_history: str = Field(default="", max_length=2000)
    notes: str = Field(default="", max_length=12000)


class PhotoHistoryExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)
    text: str = Field(min_length=1, max_length=12000)
    history: MedicalHistory


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


class MedicalRecordInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    history: MedicalHistory


class DoctorReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=64)
    reason: str = Field(default="", max_length=1000)


class SavedMessage(ChatMessage):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=1, max_length=16000)
    doctor_matches: list[DoctorReference] = Field(default_factory=list, max_length=3)
    used_history: bool = False


class ConversationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: list[SavedMessage] = Field(default_factory=list, max_length=200)
    medical_record_id: UUID | None = None
    use_history: bool = False
    revision: int = Field(default=1, ge=1, le=2147483646)
