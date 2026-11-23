---
title: PULSE Medical Assistant
emoji: 🩺
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

# PULSE — Medical Information Assistant

PULSE combines a FastAPI backend on Hugging Face Spaces with a static HTML/CSS/JavaScript
frontend on Vercel. Medical reference retrieval uses MiniLM and Pinecone; Qwen 27B on
Groq handles both chat and document-photo transcription through one shared `AI_MODEL` setting.

This update adds **email/password login, an optional medical-history form, photo-to-text with
review, and a fictional doctor directory**. Follow [SETUP.md](SETUP.md) to connect your
Supabase account and finish deployment. The repository contains the implementation;
cloud accounts, database migration, credentials, and deployment still require setup.

## Features

- **Reference-based chat:** retrieve medical passages from the existing Pinecone index.
- **Account entry:** a full-page login/create-account screen with a Continue as guest option. Existing sessions open the app directly; signing out returns to login.
- **Email/password login:** registration, login, email confirmation, and password reset through
  Supabase Auth. Supabase stores salted bcrypt hashes; PULSE never persists raw passwords.
- **Medical-history library:** multiple named records containing conditions, medications, allergies, surgeries, family history, and reviewed document text. Choose a main record separately for each chat and explicitly enable sharing.
- **Saved conversations:** signed-in chats persist in Supabase and can be reopened or deleted from the sidebar. Titles use a short subject from the first user message without another model call. Guest chats stay in memory for the current visit.
- **Account isolation:** FastAPI verifies the caller's token through Supabase Auth, and database
  requests use that same token so row-level security applies. No service-role key is required.
- **Optional document photo transcription:** camera/file input → Groq vision model → editable
  field suggestions and transcription preview → apply reviewed fields → explicit save. PULSE does not persist original images.
- **Fictional doctors:** 20 JSON profiles, including resume text, with topic, city, specialty,
  and fee filters. Chat proactively matches current symptoms, earlier user messages, and saved history when explicitly enabled. Current-message matches take priority, and cards explain which context matched. Matching is based on catalog keywords; the model explains the supplied profiles.
  These invented profiles cannot be booked and are not clinical referrals.
- **Readable chat:** doctor details appear in cards rather than duplicated comparison tables. Wide Markdown tables scroll horizontally, and message blocks retain their full height in the conversation.
- **Safer chat rendering:** sanitize assistant Markdown; clear chat when accounts, history,
  or history-sharing preferences change.

PULSE provides educational information, not diagnosis or a substitute for professional care.
Photo extraction transcribes written documents; it does not interpret medical scans or diagnose
conditions from photographs. All doctor data is fictional.

## Architecture

```text
Static frontend (Vercel)
  ├── Supabase Auth → email/password (salted bcrypt hashes)
  └── FastAPI (Hugging Face Space)
        ├── Supabase Auth verifies user → medical_records + conversations (RLS, caller JWT)
        ├── MiniLM → existing Pinecone medical reference index
        ├── data/doctors.json → deterministic directory matching
        └── Groq Qwen 27B (AI_MODEL)
              ├── chat response
              └── optional photo transcription preview
```

The existing embedding model is `sentence-transformers/all-MiniLM-L6-v2`. This update does
not switch embedding models or re-ingest data. Short structured profiles are supplied directly
to chat when enabled, and fictional doctors use keyword matching plus explicit filters.
Personal history is not inserted into the reference index.

## Setup and development

See [SETUP.md](SETUP.md) for complete Supabase email/password setup, configuration, optional vision,
and deployment instructions. The main configuration files are:

| File | Purpose |
| --- | --- |
| `.env.example` | Backend environment variable template |
| `frontend/config.js` | Public frontend API URL and Supabase publishable configuration |
| `supabase/schema.sql` | Table, validation, timestamp trigger, and ownership policies |
| `data/doctors.json` | Fictional doctor catalog |

Use Python 3.11+ and an existing Pinecone index containing medical reference documents
embedded with MiniLM. The original ingestion script and datasets are not included.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env
# Configure .env and frontend/config.js; never put secrets into public frontend files.
uvicorn main:app --host 0.0.0.0 --port 7860 --reload
```

FastAPI serves the frontend and its assets at `http://localhost:7860/`. To serve only the
static frontend, run `python -m http.server 5500 --directory frontend`. Match Supabase's
allowed email confirmation/recovery redirects and backend CORS origins to whichever origin you use.

```bash
python -m pytest -q
node --check frontend/app.js
node --test tests/frontend.test.cjs
```

Tests mock external calls and do not require keys, inference, or model downloads. Hosted
email authentication, real database policies, retrieval, and inference still need testing after configuration.
The frontend has no build step and no Node dependency installation is needed for its tests.

## API

| Endpoint | Authentication | Behavior |
| --- | --- | --- |
| `GET /health` | None | Process health; does not probe external services |
| `POST /chat` | Optional; required for `use_history: true` | Reference-based chat and optional fictional doctor cards |
| `GET /medical-records` | Required | List named records without their full medical text |
| `POST /medical-records` | Required | Create a named medical-history record |
| `GET /medical-records/{id}` | Required | Read one owned record |
| `PUT /medical-records/{id}` | Required | Edit one owned record |
| `DELETE /medical-records/{id}` | Required | Remove one record and detach it from chats |
| `GET /conversations` | Required | Paginated titles and metadata, without messages |
| `POST /conversations` | Required | Create a chat with title derived from its first user message |
| `GET /conversations/{id}` | Required | Restore messages, doctor cards, and record selection |
| `PUT /conversations/{id}` | Required | Save messages and selection, with revision conflict protection |
| `DELETE /conversations/{id}` | Required | Delete the owned chat |
| `POST /history/extract` | Required | Multipart image + `consent=true`; return review text without saving |
| `GET /doctors` | None | Fictional catalog; optional `query`, `city`, `specialty`, `max_fee` filters |

Authenticated requests use `Authorization: Bearer <Supabase access token>`. User IDs are
resolved from verified tokens, never accepted as profile ownership inputs.

Example chat request:

```json
{
  "messages": [{ "role": "user", "content": "Find a doctor for migraines" }],
  "use_history": false
}
```

Example medical-record creation:

```json
{
  "name": "General history",
  "history": {
    "conditions": "Asthma",
    "medications": "",
    "allergies": "Penicillin",
    "surgeries": "",
    "family_history": "",
    "notes": "User-reviewed notes"
  }
}
```

`/chat` returns `reply`, `doctors`, and `used_history`. History fields are optional strings
with length limits. Chat accepts user/assistant roles only, up to 40 messages, each at most
8,000 characters; the browser sends a recent window. Signed-in conversations store up to 200
messages in Supabase; guest conversations stay in memory. `medical_record_id` selects the only
saved history loaded when `use_history` is true. Selecting a record does not itself enable sharing.
Changing the record affects future replies; existing messages are retained. Old `/profile` routes
return HTTP 410 so outdated frontends refresh instead of writing hidden legacy history.

## Deployment

Deploy the Dockerfile to the existing HF Space and the `frontend/` directory to Vercel.
Run `supabase/chat_history_migration.sql` after the original schema before deploying this update.
See [SETUP.md](SETUP.md) for environment values and account steps. Never commit `.env` or put
Groq, Pinecone, user passwords, or Supabase secret keys in browser configuration.
A Supabase publishable key is intentionally public; database row-level security protects records.

The Dockerfile pre-caches MiniLM. Account and doctor routes load without downloading the
embedding model at runtime; retrieval initializes lazily on the first chat request.

## Limits

- Supabase email authentication and hosted services require owner configuration before account features work.
  Email confirmation and password reset require working SMTP delivery; see SETUP.md.
- Both chat and photo transcription use Groq's `qwen/qwen3.8-27b` through `AI_MODEL`.
  Set `PHOTO_EXTRACTION_ENABLED=false` to disable photo extraction. Old `CHAT_MODEL` and
  `VISION_MODEL` settings are no longer read. Images are JPEG/PNG/WebP, up to 5 MB; PDF and HEIC are not supported.
- AI transcription may be wrong, particularly with handwriting; user review is required.
- Doctor matching uses catalog keywords and filters, not a clinical suitability assessment.
- Chat/vision inference use provider quotas and can incur charges under your account's plan.
- This demo does not include production abuse controls, a clinical triage system, encrypted
  application-level medical fields, audit workflows, or a patient-data compliance certification.
  Model instructions are not guaranteed enforcement of medical safety.

No license file is currently included.
