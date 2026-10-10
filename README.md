<div align="center">

# 🩺 PULSE

### AI-Powered Medical Information Assistant

*Evidence-based medical Q&A, grounded by retrieval — not model guesswork.*

[![Frontend](https://img.shields.io/badge/Frontend-Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://pulse-med.vercel.app/)
[![Backend](https://img.shields.io/badge/Backend-Hugging%20Face%20Spaces-FFD21E?style=for-the-badge)](https://simonsimply-pulse.hf.space)
[![Python](https://img.shields.io/badge/Python-3.11-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Groq](https://img.shields.io/badge/Groq-LLaMA%203.3%2070B-F55036?style=for-the-badge)](https://groq.com/)
[![Pinecone](https://img.shields.io/badge/Pinecone-Vector%20DB-00BFA5?style=for-the-badge)](https://www.pinecone.io/)

</div>

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Live Demo](#-live-demo)
- [Features](#-features)
- [How It Works](#-how-it-works)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Environment Variables](#environment-variables)
  - [Populating the Knowledge Base](#populating-the-knowledge-base)
  - [Running Locally](#running-locally)
- [Running with Docker](#-running-with-docker)
- [Deployment](#-deployment)
  - [Backend → Hugging Face Spaces](#backend--hugging-face-spaces)
  - [Frontend → Vercel](#frontend--vercel)
- [API Reference](#-api-reference)
- [Safety Design](#-safety-design)
- [Known Limitations & Notes](#-known-limitations--notes)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🔍 Overview

**PULSE** is a Retrieval-Augmented Generation (RAG) medical chatbot. Instead of answering purely from a language model's parametric memory, every query is first used to retrieve the most relevant passages from a Pinecone vector index, and the model is instructed to answer *only* from that retrieved context. That grounding is what keeps answers traceable and reduces confident-sounding fabrication.

The backend is a small FastAPI service that handles embedding, retrieval, prompt construction, and the call to the LLM. The frontend is a dependency-free HTML/CSS/JS chat interface — no build step, no framework.

> ⚠️ **PULSE is for informational and educational purposes only.** It is not a substitute for professional medical advice, diagnosis, or treatment. Always consult a licensed healthcare professional.

---

## 🌐 Live Demo

| Component | URL |
|---|---|
| **Chat UI** (Vercel) | [pulse-med.vercel.app](https://pulse-med.vercel.app/) |
| **API base** (Hugging Face Spaces) | [simonsimply-pulse.hf.space](https://simonsimply-pulse.hf.space) |

Try one of these to get started:
- *"What are the symptoms of diabetes?"*
- *"How does ibuprofen work?"*
- *"What is hypertension?"*
- *"Signs of a vitamin D deficiency"*

---

## ✨ Features

**🧠 Retrieval-Augmented Generation**
Every answer is grounded in the top-3 most similar chunks pulled from a Pinecone index, not the model's raw training data.

**💬 Multi-Turn Conversation**
The full message history is kept client-side and re-sent with each request, so follow-up questions stay coherent.

**🛡️ Hallucination Guardrail**
If nothing relevant turns up in the retrieved context, the system prompt instructs the model to say so explicitly rather than guess.

**🚑 Emergency Escalation**
Queries that read as critically urgent are met with an immediate recommendation to seek emergency care.

**🔒 Scope Enforcement**
Non-medical questions are redirected back to health topics at the prompt level.

**⚠️ Mandatory Disclaimer**
Every response containing medical information is required (by the system prompt) to end with a standardized AI-not-a-doctor disclaimer.

**⚡ Fast Inference**
Generation runs on Groq's LPU inference engine with Llama 3.3 70B Versatile.

**📱 Framework-Free UI**
A single HTML/CSS/JS bundle with a collapsible sidebar, starter-question chips, a typing indicator, and Markdown-rendered assistant replies (via `marked.js`).

**🐳 Container-First**
Ships with a `Dockerfile` that pre-caches the embedding model at build time for faster cold starts — ready to deploy anywhere that runs containers.

---

## 🔧 How It Works

```
Browser (Vercel-hosted frontend)
        │
        │   POST /chat   { messages: [...history] }
        ▼
┌──────────────────────────────────────────────┐
│     FastAPI backend (Hugging Face Spaces)     │
│                                                │
│  1. Take the latest user message              │
│  2. Embed it → all-MiniLM-L6-v2 (local)       │
│  3. Similarity search Pinecone index          │
│     "pulse-medical-db"          (top k = 3)   │
│  4. Concatenate the 3 chunks into `context`   │
│  5. Inject `context` into the system prompt   │
│  6. Send [system prompt + full history]       │
│     to Groq → llama-3.3-70b-versatile         │
│     (temperature = 0.2, max_tokens = 1024)    │
│  7. Return the model's reply as JSON          │
└──────────────────────────────────────────────┘
        │
        ▼
   { "reply": "..." }
```

1. **Query embedding** — the newest user message is embedded with `sentence-transformers/all-MiniLM-L6-v2`, run locally via `langchain-huggingface` (no external embedding API call).
2. **Semantic retrieval** — that vector is used to search the `pulse-medical-db` Pinecone index for the 3 most similar chunks, via `langchain-pinecone`.
3. **Context injection** — the retrieved chunks are concatenated and dropped into a system prompt that enforces context-first answering, explicit "I don't know" behavior, safety escalation, scope limits, and the disclaimer requirement (see [Safety Design](#-safety-design)).
4. **Generation** — the system prompt plus the entire conversation history is sent to Groq's `llama-3.3-70b-versatile` at low temperature for more deterministic, factual output.
5. **Response** — the reply is returned as `{"reply": "..."}` and rendered client-side as Markdown.

---

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Backend framework | [FastAPI](https://fastapi.tiangolo.com/) + [Uvicorn](https://www.uvicorn.org/) |
| LLM inference | [Groq API](https://groq.com/) — GPT-OSS 120B |
| Vector database | [Pinecone](https://www.pinecone.io/) (index: `pulse-medical-db`) |
| Embedding model | [`sentence-transformers/all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) via `langchain-huggingface` |
| RAG orchestration | [LangChain](https://www.langchain.com/) (`langchain-pinecone`, `langchain-huggingface`, `langchain-core`) |
| Request validation | [Pydantic](https://docs.pydantic.dev/) |
| Frontend | Vanilla HTML5 / CSS3 / JavaScript — no framework, no build step |
| Markdown rendering | [marked.js](https://marked.js.org/) (via CDN) |
| Fonts | DM Serif Display + DM Sans (Google Fonts) |
| Containerization | Docker (`python:3.11-slim`) |
| Backend hosting | Hugging Face Spaces (Docker SDK) |
| Frontend hosting | Vercel |
| Language runtime | Python 3.11 |

---

## 📁 Project Structure

```
PULSE-Med-/
├── .gitignore
├── .python-version        # pyenv pin (3.11.3) — a leftover from local/Render-era tooling
├── Dockerfile              # Builds the image; the real source of truth for the Python version now
├── README.md
├── requirements.txt        # Python dependencies
├── runtime.txt              # Render-style runtime pin (3.11.0) — unused by the current Docker deploy
├── main.py                  # FastAPI app: routes, RAG pipeline, Groq call
└── frontend/
    ├── index.html              # Chat UI shell
    ├── style.css                # Design tokens, layout, responsive rules
    └── app.js                    # Chat state, API calls, Markdown rendering
```

> `runtime.txt` and `.python-version` predate the move to a Docker-based deploy (see [Known Limitations & Notes](#-known-limitations--notes)) and no longer affect how the app is built or run — the `Dockerfile`'s `FROM python:3.11-slim` is what actually pins the interpreter today.

---

## 🚀 Getting Started

### Prerequisites

- Python **3.11+**
- A **Groq API key** — [console.groq.com](https://console.groq.com)
- A **Pinecone API key**, plus an existing index named `pulse-medical-db` populated with embedded medical reference text (see [Populating the Knowledge Base](#populating-the-knowledge-base) — this isn't something `pip install` gets you)
- `git`

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/SSB-Coder/PULSE-Med-.git
cd PULSE-Med-

# 2. Create and activate a virtual environment (recommended)
python -m venv venv
source venv/bin/activate      # On Windows: venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt
```

### Environment Variables

Create a `.env` file in the project root:

```env
GROQ_API_KEY=your_groq_api_key_here
PINECONE_API_KEY=your_pinecone_api_key_here

# Optional — defaults to 7860
PORT=7860
```

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GROQ_API_KEY` | Yes | — | Read explicitly via `os.getenv()` in `main.py` |
| `PINECONE_API_KEY` | Yes | — | Not referenced directly in `main.py` — picked up implicitly by the Pinecone client from the environment, but still required |
| `PORT` | No | `7860` | Port Uvicorn binds to |

`.env` is already covered by `.gitignore` — never commit real keys. Also note that the embedding model, Pinecone client, and Groq client are all initialized at **module load time** in `main.py`, not per-request — so a missing or invalid key tends to surface as a startup failure or an error on the very first request, rather than a graceful per-call check.

### Populating the Knowledge Base

`main.py` expects a Pinecone index literally named `pulse-medical-db` (hardcoded, not env-configurable) that's already populated with embedded medical reference text. The ingestion script and source datasets originally used to build that index — `ingest_data.py`, `medic.csv`, `convo.csv` — are excluded via `.gitignore` and aren't part of this repository.

To run PULSE with meaningful answers, you'll need to:
1. Create a Pinecone index named `pulse-medical-db` (or update the `index_name` in `main.py` to match your own).
2. Chunk your own medical source documents.
3. Embed each chunk with the same model used at query time (`sentence-transformers/all-MiniLM-L6-v2`) so query and document vectors live in the same space.
4. Upsert the resulting vectors into the index.

Without this step, `/chat` will still respond, but with little or no relevant context to draw from.

### Running Locally

```bash
# Start the FastAPI server
python main.py

# ...or with uvicorn directly, with auto-reload
uvicorn main:app --host 0.0.0.0 --port 7860 --reload
```

The server itself serves the chat UI at `http://localhost:7860`. If you're working on the frontend specifically, it's more reliable to serve the `frontend/` folder on its own:

```bash
cd frontend
python -m http.server 5500
```

Then open `http://localhost:5500`. This matches how the production Vercel deployment serves the same three files, and sidesteps a static-path quirk in the backend's self-hosted UI — see [Known Limitations & Notes](#-known-limitations--notes).

---

## 🐳 Running with Docker

```bash
# Build the image
docker build -t pulse-med .

# Run the container
docker run -p 7860:7860 \
  -e GROQ_API_KEY=your_key_here \
  -e PINECONE_API_KEY=your_key_here \
  pulse-med
```

The `Dockerfile` pre-downloads and caches the `all-MiniLM-L6-v2` embedding model at build time (see the `RUN python -c "..."` step), so the container doesn't need to fetch it on every cold start. Visit `http://localhost:7860` once it's running.

---

## 📦 Deployment

### Backend → Hugging Face Spaces

This repo's backend is deployed as a **Docker SDK Space** on Hugging Face:

1. Create a new Space at [huggingface.co/new-space](https://huggingface.co/new-space) and choose **Docker** as the Space SDK.
2. Push this repository's contents to the Space (Spaces are git repos — add the Space as a remote and push, or connect it via GitHub).
3. In the Space's **Settings → Variables and secrets**, add `GROQ_API_KEY` and `PINECONE_API_KEY` as secrets.
4. Hugging Face builds the image straight from the `Dockerfile`. Since it already exposes port `7860` — the port Spaces' Docker SDK expects — no extra configuration is needed.
5. The Space becomes reachable at `https://<your-username>-<space-name>.hf.space`. This project's production backend lives at `https://simonsimply-pulse.hf.space`, which is the exact URL hardcoded as `API_URL` in `frontend/app.js`.

### Frontend → Vercel

1. Import this repository into [Vercel](https://vercel.com/).
2. Set the **Root Directory** to `frontend`. It's a static site — no build command or framework preset required.
3. If you're pointing at your own backend, update the `API_URL` constant at the top of `frontend/app.js` to your Hugging Face Space URL **before** deploying.
4. Deploy. Vercel serves `index.html`, `style.css`, and `app.js` as siblings with normal relative-path resolution, so the asset-path quirk described below doesn't apply here.

Because the two are on different domains, the browser makes cross-origin requests from Vercel to Hugging Face Spaces. The backend already sets `allow_origins=["*"]`, so no additional CORS setup is needed on either side.

---

## 📡 API Reference

### `POST /chat`

Send a conversation to PULSE and get back a response grounded in the RAG knowledge base.

**Request**

```json
{
  "messages": [
    { "role": "user", "content": "What are the symptoms of diabetes?" }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `messages` | `array` | Full conversation history. Each item has `role` (`"user"` or `"assistant"`) and `content` (string). |

**Response**

```json
{
  "reply": "Diabetes commonly presents with...\n\n⚠️ Disclaimer: I am an AI, not a doctor..."
}
```

**Errors**

| Status | Meaning |
|---|---|
| `400` | `messages` was empty |
| `500` | Internal error (e.g. Groq or Pinecone call failed) |

Both error responses come back as `{"detail": "..."}` (standard FastAPI/`HTTPException` shape). The frontend actually surfaces that `detail` text directly in the chat window when `reply` is missing, so a `400`/`500` shows up as an assistant-style message rather than failing silently — see the fallback in `app.js`.

> Note: the app is created with `redirect_slashes=False`, so call `/chat` exactly — a trailing-slash `/chat/` request will not be redirected.

### `GET /`

Returns `frontend/index.html`.

### `GET /static/*`

Serves the contents of `frontend/` (e.g. `/static/style.css`, `/static/app.js`).

---

## 🩺 Safety Design

The system prompt in `main.py` enforces the same guardrails on every single request:

- **Context-first** — answer only from the retrieved context; don't fall back on general training knowledge unless the context genuinely can't answer the question.
- **Explicit uncertainty** — if the answer isn't in the retrieved context, say so directly instead of guessing.
- **Emergency escalation** — critically urgent queries get an immediate nudge toward emergency care.
- **Scope limitation** — non-medical questions are redirected back to health topics.
- **Mandatory disclaimer** — every medical response must end with:
  > "⚠️ Disclaimer: I am an AI, not a doctor. This information is for educational purposes and should not replace professional medical advice. Please consult a healthcare professional for personalized guidance."

These are prompt-level instructions to the LLM, not hard code-level filters — they shape behavior but aren't a guaranteed enforcement mechanism.

---

## 🧩 Known Limitations & Notes

A few things worth knowing if you're extending or redeploying this project:

- **Open CORS, no auth, no rate limiting** — `allow_origins=["*"]` and `/chat` has no API key or throttling of its own. Fine for a personal demo; worth locking down before wider public exposure, both to control Groq/Pinecone usage costs and to prevent abuse.
- **No server-side chat storage** — conversation history lives only in the browser's `chatHistory` JS array. A page refresh or hitting "Reset" clears it permanently.
- **Hardcoded index name** — `pulse-medical-db` is set directly in `main.py` rather than read from an environment variable, so switching indexes means editing code.
- **Ingestion pipeline isn't included** — `ingest_data.py`, `medic.csv`, and `convo.csv` are all `.gitignore`d, meaning the process that built the original knowledge base isn't part of this repo (see [Populating the Knowledge Base](#populating-the-knowledge-base)).
- **`runtime.txt` / `.python-version` are vestigial** — both predate the current Docker-based deployment (git history shows a `render.yaml` was added and later removed) and have no effect on the app as it's built and run today.
- **Backend's self-served UI has a static-path mismatch** — `index.html` links `style.css`/`app.js` with relative paths, which resolve to `/style.css` and `/app.js` when served from the backend's `/` route. But only `/static/style.css` and `/static/app.js` are actually mounted, so those two asset requests 404 (verified directly). Visiting the Hugging Face Space URL in a browser loads the HTML but not its styling or script. This doesn't affect the production setup, since Vercel serves the three frontend files correctly on its own — it just means the backend isn't a fully working standalone UI host as-is.

---

## 🤝 Contributing

1. **Fork** the repository.
2. **Create** a feature branch: `git checkout -b feature/your-feature-name`
3. **Commit** your changes: `git commit -m "feat: add your feature"`
4. **Push** to your branch: `git push origin feature/your-feature-name`
5. **Open** a Pull Request against `main`.

Please keep new dependencies added to `requirements.txt` and follow the existing code style.

---

## 📄 License

No `LICENSE` file is currently included in this repository, so all rights are reserved by default — the code is publicly visible but not formally open-source yet. If you want to explicitly grant reuse rights, consider adding a `LICENSE` file (MIT is a common, permissive choice for projects like this).

---

<div align="center">

Built by [SSB-Coder](https://github.com/SSB-Coder)

*PULSE is for informational purposes only — always consult a licensed healthcare professional for medical decisions.*

</div>
