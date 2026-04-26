// 1. Initialize an array to store history
let chatHistory = [];

async function sendbtn() {
    const input = document.getElementById("user-input");
    const chatBox = document.getElementById("chat-box");
    const userMessage = input.value.trim();
    if (!userMessage) return;

    // 2. Add user message to history
    chatHistory.push({ role: "user", content: userMessage });
    chatBox.innerHTML += `<div class="message user">${userMessage}</div>`;
    input.value = "";

    try {
        // 3. Send the WHOLE history to the backend
        const response = await fetch("http://localhost:8000/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: chatHistory }), // Sending the list
        });
        
        const data = await response.json();

        // 4. Update history with Pulse's reply
        chatHistory.push({ role: "assistant", content: data.reply });
        
        const botDiv = document.createElement('div');
        botDiv.className = "message assistant";
        botDiv.innerHTML = marked.parse(data.reply);
        chatBox.appendChild(botDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
    } catch (error) {
        chatBox.innerHTML += `<div class="message assistant">Sorry, I'm having trouble connecting.</div>`;
    }
}