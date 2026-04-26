import os
from typing import List
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from groq import Groq
from pinecone import Pinecone
from sentence_transformers import SentenceTransformer

load_dotenv()

app = FastAPI(title="Pulse Medical Assistant")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="frontend"), name="static")

@app.get("/")
async def read_index():
    return FileResponse("frontend/index.html")

# -------------------------------------------------------------------
# ML / Vector DB setup (runs once at startup)
# -------------------------------------------------------------------
embedder = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

pc = Pinecone(api_key=os.getenv("PINECONE_API_KEY"))
index = pc.Index("pulse-medical-db")

groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# -------------------------------------------------------------------
# Models
# -------------------------------------------------------------------
class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[ChatMessage]

# -------------------------------------------------------------------
# Routes
# -------------------------------------------------------------------
@app.post("/chat")
async def chat(request: ChatRequest):
    if not request.messages:
        raise HTTPException(status_code=400, detail="No messages provided.")

    try:
        latest_message = request.messages[-1].content

        # Embed the query and search Pinecone directly
        query_embedding = embedder.encode(latest_message).tolist()
        results = index.query(vector=query_embedding, top_k=3, include_metadata=True)

        context = "\n\n".join([
            match["metadata"].get("text", "")
            for match in results["matches"]
        ])

        system_prompt = f"""You are Pulse, an expert, professional medical assistant.
Your goal is to provide accurate, evidence-based, and empathetic information.

### OPERATIONAL RULES:
1. **Context-First**: Answer using ONLY the provided Context below. Do not use external knowledge unless the context is insufficient.
2. **Hallucination Prevention**: If the answer cannot be found in the context, clearly state: "I cannot find information regarding this in my provided medical records." Do not guess or fabricate.
3. **Safety First**: Always prioritize patient safety. If a request is critically urgent, advise the user to seek emergency medical care immediately.
4. **Scope Limitation**: If the user asks non-medical questions, politely redirect them back to medical inquiries.
5. **Formatting**: Use bullet points for readability. Be concise but detailed enough to be helpful.

### REQUIRED DISCLAIMER:
At the end of every response that provides medical advice or information, you MUST add exactly this text:
"⚠️ Disclaimer: I am an AI, not a doctor. This information is for educational purposes and should not replace professional medical advice. Please consult a healthcare professional for personalized guidance."

### CURRENT CONTEXT:
{context}
"""

        full_history = [{"role": "system", "content": system_prompt}]
        for msg in request.messages:
            full_history.append({"role": msg.role, "content": msg.content})

        response = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=full_history,
            max_tokens=1024,
            temperature=0.2,
        )

        return {"reply": response.choices[0].message.content}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
