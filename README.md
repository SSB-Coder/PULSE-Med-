<div align="center">

# 🩺 PULSE Med

### AI-Powered Medical Information Assistant

[![Live Demo](https://img.shields.io/badge/Live%20Demo-pulse--med.vercel.app-blue?style=for-the-badge&logo=vercel)](https://pulse-med.vercel.app/)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![LLaMA](https://img.shields.io/badge/LLaMA%203.3%2070B-Groq-F55036?style=for-the-badge)](https://groq.com/)
[![Pinecone](https://img.shields.io/badge/Pinecone-Vector%20DB-00BFA5?style=for-the-badge)](https://www.pinecone.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

*Evidence-based medical Q&A powered by RAG — not hallucination.*

</div>

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Live Demo](#-live-demo)
- [Features](#-features)
- [Architecture](#-architecture)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Environment Variables](#environment-variables)
  - [Running Locally](#running-locally)
- [Docker](#-docker)
- [Deployment](#-deployment)
- [API Reference](#-api-reference)
- [Safety & Disclaimer](#️-safety--disclaimer)
- [Contributing](#-contributing)

---

## 🔍 Overview

**PULSE** is a Retrieval-Augmented Generation (RAG) medical chatbot that answers health and medical questions using a curated, evidence-based knowledge base. Rather than relying on a language model's potentially outdated or hallucinated training data, PULSE first retrieves the most relevant medical context from a Pinecone vector database before generating a response — ensuring answers are grounded, accurate, and traceable.

Built with a FastAPI backend and a clean vanilla JavaScript frontend, PULSE is designed to be a responsible AI health companion: it always cites its scope, redirects off-topic questions, and appends a safety disclaimer to every piece of medical advice.

> ⚠️ **PULSE is for informational and educational purposes only.** It is not a substitute for professional medical advice, diagnosis, or treatment. Always consult a licensed healthcare professional.

---

## 🌐 Live Demo

Try PULSE right now — no setup required:

**[https://pulse-med.vercel.app/](https://pulse-med.vercel.app/)**

Example questions to get started:
- *"What are the symptoms of diabetes?"*
- *"How does ibuprofen work?"*
- *"What is hypertension?"*
- *"Signs of a vitamin D deficiency?"*

---

## ✨ Features

**🧠 Retrieval-Augmented Generation (RAG)**
Answers are grounded in retrieved medical documents from a Pinecone vector store — not the model's raw parametric memory — dramatically reducing hallucinations.

**💬 Multi-turn Conversation**
Maintains full chat history in each request, enabling coherent, context-aware follow-up questions across a conversation session.

**🛡️ Hallucination Prevention**
If the answer cannot be found in the retrieved context, PULSE explicitly states it cannot find the information rather than guessing or fabricating a response.

**🚨 Safety-First Design**
Critically urgent queries trigger an immediate recommendation to seek emergency medical care. Every medical response is capped with a mandatory disclaimer.

**🔒 Scope Enforcement**
Non-medical questions are politely redirected back to health topics, keeping the assistant focused and trustworthy.

**⚡ Fast Inference via Groq**
Uses Groq's LPU inference engine with LLaMA 3.3 70B Versatile for near-instant, high-quality responses.

**📱 Clean, Responsive UI**
A lightweight vanilla HTML/CSS/JS frontend with suggested starter questions, a reset button, and mobile-friendly layout — no framework required.

**🐳 Docker & Cloud Ready**
Ships with a `Dockerfile` and a `render.yaml` for one-command containerization and seamless deployment to Render. Frontend deploys to Vercel.

---

## 🏗️ Architecture

```
User (Browser)
     │
     │  HTTP POST /chat  { messages: [...] }
     ▼
┌─────────────────────────────────────┐
│         FastAPI Backend             │
│                                     │
│  1. Extract latest user message     │
│  2. Embed query via HuggingFace     │
│     (all-MiniLM-L6-v2)              │
│  3. Similarity search Pinecone      │
│     vector store  (top k=3 docs)    │
│  4. Inject retrieved context into   │
│     system prompt                   │
│  5. Send full chat history +        │
│     context to Groq API             │
│     (LLaMA 3.3 70B Versatile)       │
│  6. Return AI reply to client       │
└─────────────────────────────────────┘
     │
     ▼
  Response: { "reply": "..." }
```

### RAG Flow in Detail

1. **Query Embedding** — The user's latest message is converted into a dense vector using `sentence-transformers/all-MiniLM-L6-v2` via LangChain HuggingFace.
2. **Semantic Retrieval** — The vector is used to query the `pulse-medical-db` Pinecone index, returning the 3 most semantically relevant medical document chunks.
3. **Context Injection** — Retrieved chunks are concatenated and injected into a structured system prompt that instructs the model to answer *only* from the provided context.
4. **LLM Generation** — The full conversation history (system prompt + all prior turns + new user message) is sent to Groq's API, which runs LLaMA 3.3 70B Versatile at `temperature=0.2` for deterministic, factual responses.
5. **Response** — The assistant's reply is returned as JSON and rendered in the chat UI.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Backend Framework** | [FastAPI](https://fastapi.tiangolo.com/) + [Uvicorn](https://www.uvicorn.org/) |
| **LLM** | [LLaMA 3.3 70B Versatile](https://groq.com/) via Groq API |
| **Vector Database** | [Pinecone](https://www.pinecone.io/) |
| **Embeddings** | [sentence-transformers/all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) |
| **LLM Orchestration** | [LangChain](https://www.langchain.com/) (`langchain-pinecone`, `langchain-huggingface`) |
| **Data Validation** | [Pydantic](https://docs.pydantic.dev/) |
| **Frontend** | Vanilla HTML5, CSS3, JavaScript |
| **Containerization** | Docker |
| **Backend Hosting** | [Render](https://render.com/) |
| **Frontend Hosting** | [Vercel](https://vercel.com/) |
| **Language** | Python 3.11+ |

---

## 📁 Project Structure

```
PULSE-Med-/
├── frontend/               # Static frontend assets
│   ├── index.html          # Main chat interface
│   ├── *.css               # Styling
│   └── *.js                # Chat logic & API calls
│
├── main.py                 # FastAPI application entry point
│                           #   - /        → serves index.html
│                           #   - /chat    → RAG + LLM endpoint
│                           #   - /static  → mounts frontend/
│
├── requirements.txt        # Python dependencies
├── Dockerfile              # Container build instructions
├── render.yaml             # Render deployment configuration
├── runtime.txt             # Python runtime version for Render
├── .python-version         # Python version pin (pyenv)
└── .gitignore
```

---

## 🚀 Getting Started

### Prerequisites

- Python **3.11+**
- A **Groq API key** — [get one free at console.groq.com](https://console.groq.com)
- A **Pinecone API key** and a pre-populated index named `pulse-medical-db` — [sign up at pinecone.io](https://www.pinecone.io/)
- `git` and `pip`

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
# .env
GROQ_API_KEY=your_groq_api_key_here
PINECONE_API_KEY=your_pinecone_api_key_here

# Optional: override the default port (default: 7860)
PORT=7860
```

> ⚠️ Never commit your `.env` file. It's already included in `.gitignore`.

### Running Locally

```bash
# Start the FastAPI server
python main.py

# Or with uvicorn directly
uvicorn main:app --host 0.0.0.0 --port 7860 --reload
```

Then open your browser at **[http://localhost:7860](http://localhost:7860)**.

---

## 🐳 Docker

Build and run PULSE in a container:

```bash
# Build the image
docker build -t pulse-med .

# Run the container
docker run -p 7860:7860 \
  -e GROQ_API_KEY=your_key_here \
  -e PINECONE_API_KEY=your_key_here \
  pulse-med
```

Visit **[http://localhost:7860](http://localhost:7860)** — the app serves both the API and the frontend from a single container.

---

## ☁️ Deployment

### Backend — Render

The `render.yaml` at the root of the repo configures automatic deployment to [Render](https://render.com/). To deploy:

1. Fork this repository.
2. Connect your fork to Render via the dashboard.
3. Set the `GROQ_API_KEY` and `PINECONE_API_KEY` environment variables in Render's settings.
4. Render will automatically detect `render.yaml` and deploy.

### Frontend — Vercel

The frontend (`/frontend`) is deployed as a static site on Vercel. To deploy your own:

1. Import the repository into [Vercel](https://vercel.com/).
2. Set the **Root Directory** to `frontend`.
3. Update the API base URL in the frontend JS to point at your Render backend.
4. Deploy.

> **Note:** The production deployment at `pulse-med.vercel.app` serves the frontend from Vercel while the `/chat` API calls hit the Render-hosted backend.

---

## 📡 API Reference

### `POST /chat`

Send a conversation to the PULSE assistant and receive a medical response grounded in the RAG knowledge base.

**Request Body**

```json
{
  "messages": [
    { "role": "user", "content": "What are the symptoms of diabetes?" }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `messages` | `array` | Full conversation history. Each item has a `role` (`"user"` or `"assistant"`) and `content` (string). |

**Response**

```json
{
  "reply": "Diabetes presents with several key symptoms, including...\n\n⚠️ Disclaimer: I am an AI, not a doctor..."
}
```

**Error Responses**

| Status | Meaning |
|---|---|
| `400` | No messages provided in the request body |
| `500` | Internal server error (e.g., upstream API failure) |

### `GET /`

Returns the main `index.html` chat interface.

### `GET /static/*`

Serves static frontend assets (CSS, JS, images) from the `frontend/` directory.

---

## ⚠️ Safety & Disclaimer

PULSE is built with patient safety as a first-class concern. The following guardrails are enforced at the system-prompt level on every request:

- **Context-First:** Responses are generated only from retrieved medical documents. The model will not speculate beyond the provided context.
- **Explicit Uncertainty:** If the knowledge base does not contain relevant information, PULSE explicitly says so rather than fabricating an answer.
- **Emergency Escalation:** Queries that appear critically urgent prompt an immediate recommendation to seek emergency medical care.
- **Mandatory Disclaimer:** Every response that provides medical information ends with a standardized disclaimer reminding the user that PULSE is an AI, not a licensed physician.
- **Scope Limitation:** Questions outside the medical domain are politely redirected.

**PULSE does not store, log, or transmit personal health data entered by users.**

---

## 🤝 Contributing

Contributions are welcome! Here's how to get involved:

1. **Fork** the repository.
2. **Create** a feature branch: `git checkout -b feature/your-feature-name`
3. **Commit** your changes: `git commit -m "feat: add your feature"`
4. **Push** to your branch: `git push origin feature/your-feature-name`
5. **Open** a Pull Request against `main`.

Please ensure your code follows existing style conventions and that any new dependencies are added to `requirements.txt`.

---

## 📄 License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.

---

<div align="center">

Built with ❤️ by [SSB-Coder](https://github.com/SSB-Coder)

*PULSE is for informational purposes only — always consult a licensed healthcare professional for medical decisions.*

</div>
