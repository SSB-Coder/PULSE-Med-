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
- **Optional web evidence:** Qwen can request bounded search and public-page tools. Signed-in users approve exact generic search terms per reply. Only approved health domains can be read, with citations and dates saved alongside answers.
- **Symptom assessment:** focused follow-up questions, evidence-qualified possible causes, uncertainty, and appropriate next steps. A limited explicit red-flag interrupt skips web/model delay for a few urgent phrases; it is not a clinical triage classifier.
- **Account entry:** a full-page login/create-account screen with a Continue as guest option. Existing sessions open the app directly; signing out returns to login.
- **Email/password login:** registration, login, email confirmation, and password reset through
  Supabase Auth. Supabase stores salted bcrypt hashes; PULSE never persists raw passwords.
- **Medical-history library:** multiple named records containing conditions, medications, allergies, surgeries, family history, and reviewed document text. Choose a main record separately for each chat and explicitly enable sharing.
- **Saved conversations:** signed-in chats persist in Supabase and can be reopened or deleted from the sidebar. Titles use a short subject from the first user message without another model call. Guest chats stay in memory for the current visit.
- **Account isolation:** FastAPI verifies the caller's token through Supabase Auth, and database
  requests use that same token so row-level security applies. No service-role key is required.
- **Optional document photo transcription:** camera/file input → Groq vision model → editable
  text preview → add reviewed text to notes → explicit save. PULSE does not persist original images.
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
| `GET /web/status` | None | Availability and public-source policy, never credentials |
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
For optional web evidence, also run `supabase/web_tools_migration.sql` and enable the keyless web-search feature flag.
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

## Public web tools

`web_policy.py` validates approved generic terms and HTTPS health-source URLs. `web_tools.py`
implements keyless search and seeded page reads with public-IP connection pinning, TLS hostname
verification, robots checks, redirect validation, and bounded decoding/extraction. `web_agent.py`
executes Qwen's tool requests through that whitelist, then returns validated source metadata.
`clinical_safety.py` contains a conservative small red-flag interruption; a negative match never
implies safety. The prompt supports symptom assessment and plausible alternatives, not diagnosis.

Web mode is off by default. It requires login, the SQL budget function, and `WEB_TOOLS_ENABLED=true`.
No additional search API key is needed; Qwen still uses the existing Groq key.
Each reply requires a newly approved public query. Queries
are not automatically generated from history, rewritten by the model, or persisted in chats.
Sources and the web-mode preference are persisted; approval is not. Names can resemble generic
words, so the query filter is a guardrail, not reliable automatic de-identification: users must
review their exact public terms. Provider processing follows the selected provider's terms.

Limits: 5 web turns/minute and 50/day per account; 30/minute and 500/day across the project
(UTC fixed windows, enforced atomically in PostgreSQL). Four active web turns per API process,
one search operation (at most two public-service requests within 20 seconds), at most three sources, four tool calls, two tool rounds plus a final answer, a
60-second web budget, 2 MB/page, 5,000 characters and 6,000 UTF-8 bytes/excerpt, and a 100,000-byte
serialized web context cap. Base prompts have a 60,000-byte cap. Ordinary fallback inference
has its existing provider timeout/retry policy and can add latency after a web failure.

Pages are public HTTPS text only, from NHS, MedlinePlus, CDC, NIH, WHO, India's MoHFW/ICMR,
or FDA. This is not a general browser: no logins, clicks, form submissions, script execution,
paywall bypass, PDFs, or arbitrary URLs. Search result titles are not evidence; sources appear
only after a usable page read. Unknown citation IDs and model-supplied external links are removed
from web replies. Citations establish retrieved provenance, not the truth of a medical claim.

Assistant Markdown rendering also forbids remote image/media/style resources and removes model-supplied hyperlinks. Only server-validated source-panel links navigate outward, preventing unapproved tracking URLs from being loaded as answer images.

### Keyless search providers

PULSE uses the pinned `ddgs==9.16.1` DuckDuckGo result parser. Its default auto/multi-engine
search and network client are not used: PULSE fetches one public DuckDuckGo result page through
its own bounded, DNS-pinned transport. Search URLs are fixed by code, not supplied by the model.
If that service is blocked, has no approved results, or fails, one fallback request searches
[MedlinePlus.gov health topics](https://medlineplus.gov/about/developers/webservices/) through
NLM's public keyless XML service. `defusedxml` rejects DTDs/external entities. Only titles and
approved result URLs are used for discovery; summaries/snippets are not treated as read evidence.

The fallback covers MedlinePlus health topics, not the whole web or news. Its scope is disclosed
to Qwen and in the saved response notice. Users explicitly approve sending the same generic
terms to these services; neither receives the private transcript or selected record automatically.
Use short English topic terms such as `migraine` or `type 2 diabetes`. Terms are not rewritten
or broadened when falling back. The UI attributes MedlinePlus.gov sources through links and notices;
no endorsement is implied. Model output and page-reading safeguards are unchanged.

Search engines can block shared hosting IPs or change their HTML. PULSE does not solve CAPTCHAs,
rotate proxies, retry blocked engines, or bypass publisher controls. If both services are
unavailable, ordinary reference-based chat continues with an honest web-status notice.
Any old `BRAVE_SEARCH_API_KEY` setting is unused and can be removed. Existing web SQL tables,
quotas, and migration still apply; this provider switch requires no additional migration.
