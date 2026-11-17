"""Supabase calls use the caller's JWT so row-level security stays active."""
import os
from functools import lru_cache
from uuid import UUID
import httpx
from fastapi import HTTPException


def auth_config():
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
    if not url or not key:
        raise HTTPException(503, "Account features are not configured yet.")
    return url, key


def supabase_request(method, path, token, **kwargs):
    url, key = auth_config()
    try:
        response = httpx.request(
            method, url + path,
            headers={"apikey": key, "Authorization": f"Bearer {token}",
                     "Prefer": "resolution=merge-duplicates,return=representation"},
            timeout=15, **kwargs,
        )
    except httpx.HTTPError:
        raise HTTPException(503, "Account storage is temporarily unavailable.") from None
    if response.status_code in (401, 403):
        raise HTTPException(401, "Your session expired or access was denied. Please sign in again.")
    if not response.is_success:
        raise HTTPException(503, "Account storage is unavailable. Check the database setup.")
    return response.json() if response.content else None


def verify_user(token):
    user = supabase_request("GET", "/auth/v1/user", token)
    try:
        return str(UUID(user["id"]))
    except (ValueError, TypeError, KeyError):
        raise HTTPException(401, "Invalid account session.") from None


def get_profile(user_id, token):
    rows = supabase_request("GET", "/rest/v1/medical_profiles", token,
                            params={"user_id": f"eq.{user_id}", "select": "history,updated_at"})
    return rows[0] if rows else None


@lru_cache(maxsize=1)
def get_vector_store():
    # Keep heavy model imports out of account routes and unit tests.
    from langchain_huggingface import HuggingFaceEmbeddings
    from langchain_pinecone import PineconeVectorStore
    embed = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")
    return PineconeVectorStore(index_name=os.getenv("PINECONE_INDEX", "pulse-medical-db"), embedding=embed)


def get_groq():
    from groq import Groq
    key = os.getenv("GROQ_API_KEY")
    if not key:
        raise HTTPException(503, "AI features are not configured yet.")
    return Groq(api_key=key, timeout=45, max_retries=1)
