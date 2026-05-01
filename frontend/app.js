const API_URL = "https://simonsimply-pulse.hf.space";
let chatHistory = [];
let isLoading = false;

document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('user-input');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendbtn();
        }
    });
});

function fillInput(btn) {
    const input = document.getElementById('user-input');
    input.value = btn.innerText;
    input.focus();
}

function resetChat() {
    chatHistory = [];
    const chatBox = document.getElementById('chat-box');
    chatBox.innerHTML = `
        <div class="welcome-screen" id="welcome-screen">
            <div class="welcome-icon">🩺</div>
            <h2>Welcome to PULSE</h2>
            <p>Your AI-powered medical information assistant. Ask me about symptoms, conditions, medications, or general health topics.</p>
            <div class="suggestion-chips">
                <button class="chip" onclick="fillInput(this)">What are symptoms of diabetes?</button>
                <button class="chip" onclick="fillInput(this)">How does ibuprofen work?</button>
                <button class="chip" onclick="fillInput(this)">What is hypertension?</button>
                <button class="chip" onclick="fillInput(this)">Signs of a vitamin D deficiency</button>
            </div>
        </div>`;
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('hidden');
}

document.addEventListener('click', (e) => {
    const sidebar = document.getElementById('sidebar');
    const menuBtn = document.querySelector('.menu-btn');
    const isMobile = window.innerWidth <= 700;
    if (isMobile && !sidebar.classList.contains('hidden') && !sidebar.contains(e.target) && e.target !== menuBtn) {
        sidebar.classList.add('hidden');
    }
});

async function sendbtn() {
    if (isLoading) return;

    const input = document.getElementById('user-input');
    const chatBox = document.getElementById('chat-box');
    const userMessage = input.value.trim();
    if (!userMessage) return;

    const welcome = document.getElementById('welcome-screen');
    if (welcome) welcome.remove();

    appendMessage('user', userMessage, chatBox);
    chatHistory.push({ role: 'user', content: userMessage });
    input.value = '';

    const typingId = showTyping(chatBox);
    isLoading = true;
    setSendState(true);

    try {
        const response = await fetch(`${API_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: chatHistory })
        });

        const data = await response.json();
        const botReply = data.reply || data.detail || 'Error: No response from server.';

        removeTyping(typingId, chatBox);
        appendMessage('assistant', botReply, chatBox);
        chatHistory.push({ role: 'assistant', content: botReply });

    } catch (error) {
        removeTyping(typingId, chatBox);
        appendMessage('assistant', '⚠️ Could not connect to the Pulse server. Please ensure the backend is running.', chatBox);
        console.error('Connection failed:', error);
    } finally {
        isLoading = false;
        setSendState(false);
        chatBox.scrollTop = chatBox.scrollHeight;
    }
}

function appendMessage(role, content, chatBox) {
    const div = document.createElement('div');
    div.className = `message ${role}`;

    if (role === 'assistant') {
        div.innerHTML = marked.parse(content);
    } else {
        const span = document.createElement('span');
        span.textContent = content;
        div.appendChild(span);
    }

    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function showTyping(chatBox) {
    const id = 'typing-' + Date.now();
    const div = document.createElement('div');
    div.className = 'message assistant typing-indicator';
    div.id = id;
    div.innerHTML = `<span></span><span></span><span></span>`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
    return id;
}

function removeTyping(id, chatBox) {
    const el = document.getElementById(id);
    if (el) el.remove();
}

function setSendState(loading) {
    const btn = document.querySelector('.send-btn');
    btn.style.opacity = loading ? '0.5' : '1';
    btn.style.pointerEvents = loading ? 'none' : 'auto';
}
