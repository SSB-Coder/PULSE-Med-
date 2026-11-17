"""Validated API inputs. Medical history is user-reported, not a diagnosis."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


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
