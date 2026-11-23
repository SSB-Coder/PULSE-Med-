const config = window.PULSE_CONFIG || {};
const API_URL = (config.API_URL || window.location.origin).replace(/\/$/, '');
const HISTORY_FIELDS = ['conditions', 'medications', 'allergies', 'surgeries', 'family_history', 'notes'];
const HISTORY_FIELD_LABELS = {
    conditions: 'Conditions', medications: 'Current medications', allergies: 'Allergies',
    surgeries: 'Surgeries / hospital stays', family_history: 'Relevant family history', notes: 'Additional notes'
};
const extractedField = (field) => 'extracted-' + field;
let chatHistory = [];
let isLoading = false;
let session = null;
let authClient = null;
let accountEpoch = 0;
let chatEpoch = 0;
let selectedPhoto = null;
let extractionEpoch = 0;
let directoryEpoch = 0;
let profileEpoch = 0;
let authMode = 'login';
let authRequestEpoch = 0;
let authBusy = false;
let recoveringPassword = false;
let guestMode = false;
let entryScreen = true;
let medicalRecords = [];
let editingRecordId = null;
let selectedRecordId = null;
let recordListEpoch = 0;
let currentConversationId = null;
let conversationRevision = 1;
let conversationList = [];
let conversationListEpoch = 0;
let conversationOpenEpoch = 0;
let conversationOpening = false;
let conversationsHasMore = false;
let conversationSavePromise = null;
let chatDirty = false;
let chatMutation = 0;
let guestChatCounter = 0;
let pendingDeleteChatId = null;
let pubmedRequest = null;
const $ = (id) => document.getElementById(id);

function updateChatContext() {
    const useHistory = Boolean(session && selectedRecordId && $('use-history').checked);
    const recordName = medicalRecords.find((record) => record.id === selectedRecordId)?.name || 'selected record';
    $('session-badge').textContent = session ? 'Signed in' : 'Guest session';
    $('chat-context').textContent = useHistory
        ? `History enabled · ${recordName}. Replies and doctor matches use this record and current symptoms.`
        : session ? 'History off · Select a main medical-history record and enable sharing for this chat.'
        : 'Guest mode · Doctor matches use what you share in this conversation.';
}

function setEntryScreen(visible) {
    entryScreen = visible;
    $('app-shell').hidden = visible;
    document.body.classList.toggle('auth-gated', visible);
    $('auth-close-btn').hidden = visible;
    $('guest-entry').hidden = !visible;
    if (visible) {
        setAuthMode('login');
        showDialog('auth-dialog');
    }
}

function continueAsGuest() {
    if (authBusy || recoveringPassword) return;
    guestMode = true;
    setEntryScreen(false);
    $('auth-dialog').close();
    updateChatContext();
    $('user-input').focus();
}

async function api(path, options = {}, authenticated = true) {
    const headers = new Headers(options.headers || {});
    if (authenticated && session) headers.set('Authorization', `Bearer ${session.access_token}`);
    const response = await fetch(API_URL + path, { ...options, headers, cache: 'no-store' });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status}).`);
        error.status = response.status;
        throw error;
    }
    return data;
}

function setHistoryBusy(busy) {
    $('history-form').inert = busy;
    $('medical-record-list').inert = busy;
    $('new-record-btn').disabled = busy;
    $('save-history-btn').disabled = busy;
}

function clearExtraction(preserveInputId = null) {
    extractionEpoch++;
    selectedPhoto = null;
    ['history-photo', 'history-camera'].forEach((id) => { if (id !== preserveInputId) $(id).value = ''; });
    $('photo-consent').checked = false;
    $('extracted-text').textContent = '';
    $('extracted-fields').replaceChildren();
    $('transcription-details').open = false;
    $('extraction-review').hidden = true;
    $('extract-btn').disabled = false;
}

function populateHistory(history = {}) {
    HISTORY_FIELDS.forEach((field) => { $('history-form').elements[field].value = history[field] || ''; });
    clearExtraction();
    $('delete-confirm').hidden = true;
}

function showDialog(id) { if (!$(id).open) $(id).showModal(); }

function shortChatTitle(messages) {
    let first = (messages.find((message) => message.role === 'user')?.content || '')
        .replace(/[#*_`<>]/g, '').replace(/\s+/g, ' ').trim()
        .replace(/^(hi|hello|hey)[,! .]+/i, '')
        .replace(/^(can you|could you|please)\s+(help me\s+(with|understand)\s+)?/i, '');
    if (!first) return 'New chat';
    first = first.split(/[.!?](?:\s|$)/)[0]
        .replace(/^(i(?:'m| am) (experiencing|having)|i (have|feel)|what (is|are)|tell me about|find( me)?|recommend( me)?|looking for)\s+/i, '')
        .replace(/^(a|an|the)\s+/i, '');
    if (!first.trim()) return 'New chat';
    const words = first.split(' ');
    let title = words.slice(0, 7).join(' ').replace(/[ .?!,;:]+$/, '');
    if (title.length > 60) title = title.slice(0, 57).replace(/\s+\S*$/, '') + '…';
    else if (words.length > 7) title += '…';
    return title ? title.charAt(0).toUpperCase() + title.slice(1) : 'New chat';
}

function renderRecordChoices() {
    const select = $('chat-record-select');
    const empty = document.createElement('option');
    empty.value = ''; empty.textContent = 'No record selected';
    const options = medicalRecords.map((record) => {
        const option = document.createElement('option');
        option.value = record.id; option.textContent = record.name;
        return option;
    });
    select.replaceChildren(empty, ...options);
    select.value = selectedRecordId || '';
    const list = $('medical-record-list');
    list.replaceChildren();
    if (!medicalRecords.length) {
        const hint = document.createElement('p'); hint.className = 'small-text';
        hint.textContent = 'No records yet. Add your first medical history below.';
        list.appendChild(hint);
    }
    medicalRecords.forEach((record) => {
        const row = document.createElement('div'); row.className = 'medical-record-row';
        const edit = document.createElement('button'); edit.type = 'button';
        edit.textContent = record.name; edit.className = 'record-name-button';
        edit.setAttribute('aria-pressed', String(record.id === editingRecordId));
        edit.addEventListener('click', () => void editMedicalRecord(record.id));
        const choose = document.createElement('button'); choose.type = 'button';
        choose.textContent = record.id === selectedRecordId ? 'Selected for this chat' : 'Use for this chat';
        choose.disabled = isLoading || conversationOpening || record.id === selectedRecordId;
        choose.addEventListener('click', () => {
            selectedRecordId = record.id;
            $('chat-record-select').value = record.id;
            void changeHistoryContext();
        });
        row.append(edit, choose); list.appendChild(row);
    });
}

function beginMedicalRecord() {
    profileEpoch++;
    setHistoryBusy(false);
    $('save-history-btn').disabled = false;
    editingRecordId = null;
    populateHistory();
    $('record-name').value = '';
    $('delete-history-btn').hidden = true;
    $('history-status').textContent = 'New record. Add details or extract a photo, then save.';
    renderRecordChoices();
    $('record-name').focus();
}

async function editMedicalRecord(id) {
    const epoch = accountEpoch;
    const request = ++profileEpoch;
    setHistoryBusy(true);
    $('history-status').textContent = 'Loading medical record…';
    try {
        const data = await api('/medical-records/' + encodeURIComponent(id));
        if (epoch !== accountEpoch || request !== profileEpoch) return;
        editingRecordId = id;
        populateHistory(data.record.history);
        $('record-name').value = data.record.name;
        $('delete-history-btn').hidden = false;
        $('history-status').textContent = 'Editing this record. Other records are kept separately.';
        renderRecordChoices();
    } catch (error) {
        if (epoch === accountEpoch && request === profileEpoch) $('history-status').textContent = error.message;
    } finally {
        if (epoch === accountEpoch && request === profileEpoch) setHistoryBusy(false);
    }
}

async function loadHistory(openWhenEmpty = false) {
    const epoch = accountEpoch;
    const request = ++recordListEpoch;
    try {
        const data = await api('/medical-records');
        if (epoch !== accountEpoch || request !== recordListEpoch) return;
        medicalRecords = data.records || [];
        if (selectedRecordId && !medicalRecords.some((record) => record.id === selectedRecordId)) {
            selectedRecordId = null;
            $('use-history').checked = false;
        }
        renderRecordChoices();
        updateChatContext();
        if (openWhenEmpty && !medicalRecords.length && !recoveringPassword) {
            beginMedicalRecord();
            showDialog('history-dialog');
        }
        return true;
    } catch (error) {
        if (epoch === accountEpoch && request === recordListEpoch) $('history-status').textContent = error.message;
        return false;
    }
}

function renderConversationList() {
    $('conversation-list').replaceChildren();
    conversationList.forEach((chat) => {
        const row = document.createElement('div'); row.className = 'conversation-row';
        const open = document.createElement('button'); open.type = 'button';
        open.className = 'conversation-open'; open.textContent = chat.title;
        open.title = chat.title; open.setAttribute('aria-current', chat.id === currentConversationId ? 'true' : 'false');
        open.addEventListener('click', () => void openConversation(chat.id));
        const remove = document.createElement('button'); remove.type = 'button';
        remove.className = 'conversation-delete'; remove.textContent = '×';
        remove.setAttribute('aria-label', 'Delete chat: ' + chat.title);
        remove.addEventListener('click', () => {
            if (isLoading) return;
            pendingDeleteChatId = chat.id;
            $('delete-chat-status').textContent = '';
            showDialog('delete-chat-dialog');
        });
        row.append(open, remove); $('conversation-list').appendChild(row);
    });
    $('more-chats-btn').hidden = !session || !conversationsHasMore;
}

async function loadConversations(append = false) {
    if (!session) { renderConversationList(); return; }
    const epoch = accountEpoch;
    const request = ++conversationListEpoch;
    $('more-chats-btn').disabled = true;
    try {
        const offset = append ? conversationList.length : 0;
        const data = await api('/conversations?limit=50&offset=' + offset);
        if (epoch !== accountEpoch || request !== conversationListEpoch) return;
        const rows = data.conversations || [];
        conversationList = append ? [...conversationList, ...rows.filter((row) => !conversationList.some((old) => old.id === row.id))] : rows;
        conversationsHasMore = Boolean(data.has_more);
        renderConversationList();
        if (!chatDirty) $('conversation-status').textContent = conversationList.length ? 'Your chats are saved privately to your account.' : 'Your first message will start a saved chat.';
    } catch (error) {
        if (epoch === accountEpoch && request === conversationListEpoch) $('conversation-status').textContent = 'Could not load chats. ' + error.message;
    } finally {
        if (epoch === accountEpoch && request === conversationListEpoch) $('more-chats-btn').disabled = false;
    }
}

function storedMessages() {
    return chatHistory.map((message) => ({
        role: message.role, content: message.content,
        doctor_matches: message.doctor_matches || [], used_history: Boolean(message.used_history)
    }));
}

async function saveCurrentConversation() {
    if (!chatHistory.length) return true;
    const account = accountEpoch;
    const chat = chatEpoch;
    const previous = conversationSavePromise;
    const task = (async () => {
        if (previous) await previous;
        if (account !== accountEpoch || chat !== chatEpoch) return false;
        if (!chatDirty) return true;
        const mutation = chatMutation;
        const payload = { messages: storedMessages(), medical_record_id: selectedRecordId,
            use_history: Boolean(session && selectedRecordId && $('use-history').checked), revision: conversationRevision };
        if (!session) {
            const id = currentConversationId || 'guest-' + (++guestChatCounter);
            const conversation = { id, title: shortChatTitle(chatHistory), ...payload, messages: [...chatHistory] };
            currentConversationId = id;
            conversationList = [conversation, ...conversationList.filter((item) => item.id !== id)];
            chatDirty = chatMutation !== mutation;
            $('active-chat-title').textContent = conversation.title;
            $('conversation-status').textContent = 'Guest chats last for this visit only. Log in to save future chats.';
            renderConversationList();
            return true;
        }
        $('conversation-status').textContent = 'Saving chat…';
        try {
            const data = await api(currentConversationId ? '/conversations/' + currentConversationId : '/conversations', {
                method: currentConversationId ? 'PUT' : 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)
            });
            if (account !== accountEpoch || chat !== chatEpoch) return false;
            const conversation = data.conversation;
            if (!conversation?.id) throw new Error('The server did not confirm the save.');
            currentConversationId = conversation.id;
            conversationRevision = conversation.revision;
            chatDirty = chatMutation !== mutation;
            $('active-chat-title').textContent = conversation.title;
            conversationListEpoch++;
            $('more-chats-btn').disabled = false;
            conversationList = [conversation, ...conversationList.filter((item) => item.id !== conversation.id)];
            renderConversationList();
            $('retry-chat-save').hidden = true;
            $('save-chat-copy').hidden = true;
            $('conversation-status').textContent = chatDirty ? 'Saving your latest changes…' : 'Saved to your account.';
            return true;
        } catch (error) {
            if (account !== accountEpoch || chat !== chatEpoch) return false;
            $('conversation-status').textContent = 'Chat not saved. ' + error.message;
            $('retry-chat-save').hidden = false;
            $('save-chat-copy').hidden = !currentConversationId || ![404, 409].includes(error.status);
            return false;
        }
    })();
    conversationSavePromise = task;
    try { return await task; }
    finally { if (conversationSavePromise === task) conversationSavePromise = null; }
}

async function saveConversationCopy() {
    if (isLoading || conversationOpening || conversationSavePromise) return false;
    currentConversationId = null;
    conversationRevision = 1;
    chatDirty = true; chatMutation++;
    return saveCurrentConversation();
}

async function newChat() {
    if (isLoading || conversationOpening) { $('conversation-status').textContent = 'Wait for the current operation before starting another chat.'; return; }
    if (chatDirty && !await saveCurrentConversation()) return;
    resetChat();
}

function renderDoctorCards(doctors, usedHistory) {
    if (!doctors?.length) return;
    const cards = document.createElement('div'); cards.className = 'doctor-results';
    const heading = document.createElement('h3'); heading.className = 'doctor-results-title';
    heading.textContent = 'Doctor profiles to explore';
    const basis = document.createElement('p'); basis.className = 'small-text';
    basis.textContent = 'Demo directory · Sample profiles with invented credentials; no booking. ' +
        (usedHistory ? 'Matches used this conversation and the selected history.' : 'Matches used this conversation.');
    cards.append(heading, basis, ...doctors.map(doctorCard)); $('chat-box').appendChild(cards);
}

async function openConversation(id) {
    if (isLoading) { $('conversation-status').textContent = 'Wait for the current reply before switching chats.'; return; }
    if (id === currentConversationId) return;
    const account = accountEpoch;
    const request = ++conversationOpenEpoch;
    conversationOpening = true;
    setSendState(true);
    $('conversation-status').textContent = 'Opening chat…';
    try {
        if (chatDirty && !await saveCurrentConversation()) return;
        if (account !== accountEpoch || request !== conversationOpenEpoch) return;
        const conversation = session ? (await api('/conversations/' + encodeURIComponent(id))).conversation
            : conversationList.find((item) => item.id === id);
        if (account !== accountEpoch || request !== conversationOpenEpoch || !conversation) return;
        if (session && !await loadHistory()) throw new Error('Could not load the medical records for this chat. Try opening it again.');
        if (account !== accountEpoch || request !== conversationOpenEpoch) return;
        resetChat();
        currentConversationId = conversation.id;
        conversationRevision = conversation.revision || 1;
        selectedRecordId = medicalRecords.some((record) => record.id === conversation.medical_record_id) ? conversation.medical_record_id : null;
        $('use-history').checked = Boolean(session && selectedRecordId && conversation.use_history);
        chatHistory = conversation.messages || [];
        $('chat-box').replaceChildren();
        chatHistory.forEach((message) => {
            appendMessage(message.role, message.content, $('chat-box'));
            if (message.role === 'assistant') renderDoctorCards(message.doctors, message.used_history);
        });
        $('active-chat-title').textContent = conversation.title;
        renderRecordChoices(); renderConversationList(); updateChatContext();
        $('conversation-status').textContent = session ? 'Saved chat opened.' : 'Guest chat opened. Kept for this visit only.';
        $('chat-box').scrollTop = $('chat-box').scrollHeight;
    } catch (error) {
        if (account === accountEpoch && request === conversationOpenEpoch) $('conversation-status').textContent = error.message;
    } finally {
        if (account === accountEpoch && request === conversationOpenEpoch) {
            conversationOpening = false;
            setSendState(false);
        }
    }
}

async function deleteConversation() {
    const id = pendingDeleteChatId;
    if (!id || isLoading) return;
    const epoch = accountEpoch;
    $('confirm-delete-chat').disabled = true;
    try {
        if (session) await api('/conversations/' + encodeURIComponent(id), {method: 'DELETE'});
        if (epoch !== accountEpoch) return;
        conversationListEpoch++;
        $('more-chats-btn').disabled = false;
        conversationList = conversationList.filter((chat) => chat.id !== id);
        if (currentConversationId === id) resetChat();
        renderConversationList();
        $('delete-chat-dialog').close();
        pendingDeleteChatId = null;
    } catch (error) {
        if (epoch === accountEpoch) $('delete-chat-status').textContent = error.message;
    } finally { if (epoch === accountEpoch) $('confirm-delete-chat').disabled = false; }
}

async function changeHistoryContext() {
    if (isLoading || conversationOpening) return;
    selectedRecordId = $('chat-record-select').value || null;
    if (!selectedRecordId) $('use-history').checked = false;
    updateChatContext(); renderRecordChoices();
    if (chatHistory.length) {
        chatDirty = true; chatMutation++;
        await saveCurrentConversation();
    }
}

function applySession(nextSession) {
    const previousId = session?.user.id;
    session = nextSession;
    const signedIn = Boolean(session);
    if (signedIn) {
        guestMode = false;
        setEntryScreen(false);
        if (!recoveringPassword) $('auth-dialog').close();
    } else if (!guestMode) setEntryScreen(true);
    $('login-btn').hidden = signedIn;
    $('logout-btn').hidden = !signedIn;
    $('history-btn').hidden = !signedIn;
    $('history-toggle-label').hidden = !signedIn;
    $('record-select-label').hidden = !signedIn;
    $('account-status').textContent = signedIn ? `Signed in as ${session.user.email || 'your account'}` : 'Sign in to save your optional medical history.';
    if (previousId !== session?.user.id) {
        accountEpoch++;
        profileEpoch++;
        recordListEpoch++;
        conversationListEpoch++;
        conversationOpenEpoch++;
        medicalRecords = [];
        conversationList = [];
        editingRecordId = null;
        selectedRecordId = null;
        currentConversationId = null;
        conversationSavePromise = null;
        conversationsHasMore = false;
        pendingDeleteChatId = null;
        $('record-name').value = '';
        $('confirm-delete-chat').disabled = false;
        $('confirm-delete-btn').disabled = false;
        $('more-chats-btn').disabled = false;
        $('delete-chat-dialog').close();
        $('retry-chat-save').hidden = true;
        $('save-chat-copy').hidden = true;
        $('conversation-status').textContent = signedIn ? 'Loading your chats…' : 'Guest chats last for this visit. Log in to save them.';
        renderRecordChoices(); renderConversationList();
        clearPasswords();
        if (!signedIn) {
            recoveringPassword = false;
            if (guestMode) $('auth-dialog').close();
        }
        setHistoryBusy(false);
        $('use-history').checked = false;
        populateHistory();
        $('history-dialog').close();
        resetChat();
        if (signedIn && !recoveringPassword) { void loadHistory(true); void loadConversations(); }
    }
    updateChatContext();
}

function authRedirect(recovery = false) {
    const url = new URL(window.location.origin + window.location.pathname);
    if (recovery) url.searchParams.set('auth', 'recovery');
    return url.href;
}

function clearPasswords() {
    $('auth-password').value = '';
    $('auth-confirm').value = '';
}

function setAuthBusy(busy) {
    authBusy = busy;
    ['auth-email', 'auth-password', 'auth-confirm', 'auth-submit', 'guest-btn', 'login-mode-btn', 'signup-mode-btn', 'forgot-mode-btn']
        .forEach((id) => { $(id).disabled = busy; });
}

function setAuthMode(mode) {
    if (authBusy) return;
    authRequestEpoch++;
    authMode = mode;
    clearPasswords();
    const signup = mode === 'signup';
    const forgot = mode === 'forgot';
    const update = mode === 'update';
    const titles = { login: 'Log in to PULSE', signup: 'Create your account', forgot: 'Reset your password', update: 'Choose a new password' };
    const buttons = { login: 'Log in', signup: 'Create account', forgot: 'Send reset email', update: 'Save new password' };
    $('auth-title').textContent = titles[mode];
    $('auth-submit').textContent = buttons[mode];
    $('auth-description').textContent = signup || update
        ? 'Use a unique password with at least 12 characters. Passwords are securely hashed by Supabase.'
        : forgot ? 'Enter your account email. Open the reset link in this browser to choose a new password.'
        : 'Use your email and password to access your saved medical history.';
    $('auth-email-label').hidden = update;
    $('auth-email').required = !update;
    $('auth-password-label').hidden = forgot;
    $('auth-password').required = !forgot;
    $('auth-password').minLength = signup || update ? 12 : 1;
    $('auth-password').autocomplete = signup || update ? 'new-password' : 'current-password';
    $('auth-confirm-label').hidden = !(signup || update);
    $('auth-confirm').required = signup || update;
    $('auth-mode-links').hidden = update;
    $('login-mode-btn').hidden = mode === 'login';
    $('signup-mode-btn').hidden = signup;
    $('forgot-mode-btn').hidden = forgot;
    $('auth-status').textContent = '';
}

function clearRecoveryMarker() {
    const url = new URL(window.location.href);
    if (url.searchParams.get('auth') === 'recovery') {
        url.searchParams.delete('auth');
        window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
}

function openPasswordRecovery(nextSession) {
    recoveringPassword = true;
    applySession(nextSession);
    $('history-dialog').close();
    if (authMode !== 'update' || !$('auth-dialog').open) setAuthMode('update');
    showDialog('auth-dialog');
}

async function initializeAuth() {
    if (!config.SUPABASE_URL || !config.SUPABASE_PUBLISHABLE_KEY || !window.supabase) {
        $('account-status').textContent = 'Account setup pending. General chat and the doctor directory are available.';
        $('login-btn').disabled = true;
        $('auth-submit').disabled = true;
        $('auth-status').textContent = 'Account setup is unavailable. You can continue as a guest.';
        return;
    }
    const recoveryRedirect = new URL(window.location.href).searchParams.get('auth') === 'recovery';
    recoveringPassword = recoveryRedirect;
    authClient = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
        auth: { flowType: 'pkce', detectSessionInUrl: true }
    });
    // Subscribe before reading the session so a recovery event during URL processing is handled.
    authClient.auth.onAuthStateChange((event, nextSession) => {
        // Leave Supabase's callback before making additional async auth/storage calls.
        setTimeout(() => {
            if (event === 'PASSWORD_RECOVERY' && nextSession) openPasswordRecovery(nextSession);
            else applySession(nextSession);
        }, 0);
    });
    const { data, error } = await authClient.auth.getSession();
    if (error || (recoveryRedirect && !data.session)) {
        recoveringPassword = false;
        if (recoveryRedirect) {
            setAuthMode('forgot');
            showDialog('auth-dialog');
            $('auth-status').textContent = 'This reset link could not be verified. Request a new link and open it in the same browser.';
        } else $('account-status').textContent = 'Sign-in failed. Please try again.';
    } else if (recoveryRedirect && data.session) openPasswordRecovery(data.session);
    else applySession(data.session);
}

function login() {
    if (!authClient) return;
    setAuthMode('login');
    showDialog('auth-dialog');
    $('auth-email').focus();
}

function authErrorMessage(error, mode) {
    if (['over_email_send_rate_limit', 'over_request_rate_limit'].includes(error?.code))
        return 'Too many attempts or emails. Please wait before trying again.';
    if (error?.code === 'email_address_not_authorized')
        return 'Email delivery is not configured for this address. Contact the app owner.';
    if (error?.code === 'weak_password')
        return 'Choose a stronger password that meets the account password requirements.';
    if (mode === 'login') return 'Could not log in. Check your email and password, and confirm your email if required.';
    if (mode === 'signup') return 'Could not create the account. Check your details or try logging in if you already registered.';
    if (mode === 'update') return 'Could not change your password. Try a different password or request a new reset link.';
    return 'Could not request a reset email. Please try again later.';
}

async function submitAuth(event) {
    event.preventDefault();
    if (!authClient || authBusy) return;
    const mode = authMode;
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    if (mode !== 'update' && !email) { $('auth-status').textContent = 'Enter your email address.'; return; }
    if ((mode === 'signup' || mode === 'update') && password.length < 12) {
        $('auth-status').textContent = 'Use at least 12 characters for your password.'; return;
    }
    if ((mode === 'signup' || mode === 'update') && password !== $('auth-confirm').value) {
        $('auth-status').textContent = 'The passwords do not match.'; return;
    }
    if (mode === 'update' && !session) { $('auth-status').textContent = 'Request a new reset link before changing your password.'; return; }
    const request = ++authRequestEpoch;
    setAuthBusy(true);
    $('auth-status').textContent = 'Please wait…';
    try {
        let result;
        if (mode === 'login') result = await authClient.auth.signInWithPassword({ email, password });
        else if (mode === 'signup') result = await authClient.auth.signUp({ email, password, options: { emailRedirectTo: authRedirect() } });
        else if (mode === 'forgot') result = await authClient.auth.resetPasswordForEmail(email, { redirectTo: authRedirect(true) });
        else result = await authClient.auth.updateUser({ password });
        if (request !== authRequestEpoch) return;
        if (result.error) throw result.error;
        clearPasswords();
        if (mode === 'forgot') {
            $('auth-status').textContent = 'If this email has an account, a reset link will be sent. Check your inbox and spam folder, then open it in this browser.';
        } else if (mode === 'update') {
            recoveringPassword = false;
            clearRecoveryMarker();
            resetChat();
            $('auth-dialog').close();
            $('account-status').textContent = 'Password updated. You are signed in.';
            void loadHistory(true);
            void loadConversations();
        } else if (result.data?.session) {
            applySession(result.data.session);
            $('auth-dialog').close();
        } else if (mode === 'signup') {
            $('auth-status').textContent = 'If registration is available for this email, check your inbox for a confirmation link. After confirming, return here and log in.';
        } else throw new Error('No session returned');
    } catch (error) {
        if (request === authRequestEpoch) $('auth-status').textContent = authErrorMessage(error, mode);
    } finally {
        if (request === authRequestEpoch) { clearPasswords(); setAuthBusy(false); }
    }
}

function closeAuthDialog() {
    authRequestEpoch++;
    clearPasswords();
    setAuthBusy(false);
    if (recoveringPassword) {
        recoveringPassword = false;
        clearRecoveryMarker();
        if (session) { void loadHistory(true); void loadConversations(); }
    }
}

async function logout() {
    if (!authClient) return;
    guestMode = false;
    const { error } = await authClient.auth.signOut({ scope: 'local' });
    if (error) { $('account-status').textContent = 'Could not sign out. Please try again.'; return; }
    applySession(null);
}

async function saveHistory(event) {
    event.preventDefault();
    if (!session) return;
    const name = $('record-name').value.trim();
    if (!name) { $('history-status').textContent = 'Give this medical-history record a name.'; return; }
    const epoch = accountEpoch;
    const request = ++profileEpoch;
    const id = editingRecordId;
    const history = Object.fromEntries(HISTORY_FIELDS.map((field) => [field, $('history-form').elements[field].value.trim()]));
    $('save-history-btn').disabled = true;
    setHistoryBusy(true);
    try {
        const data = await api(id ? '/medical-records/' + id : '/medical-records', {
            method: id ? 'PUT' : 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name, history})
        });
        if (epoch !== accountEpoch || request !== profileEpoch) return;
        if (!data.record?.id) throw new Error('The server did not confirm the save.');
        editingRecordId = data.record.id;
        recordListEpoch++;
        medicalRecords = [data.record, ...medicalRecords.filter((record) => record.id !== data.record.id)];
        clearExtraction();
        $('delete-history-btn').hidden = false;
        renderRecordChoices(); updateChatContext();
        $('history-status').textContent = 'Record saved. Choose “Use for this chat” and enable history sharing to include it. Existing chats are kept.';
    } catch (error) {
        if (epoch === accountEpoch && request === profileEpoch) $('history-status').textContent = error.message;
    } finally {
        if (epoch === accountEpoch && request === profileEpoch) {
            $('save-history-btn').disabled = false;
            setHistoryBusy(false);
        }
    }
}

async function deleteHistory() {
    if (!session || !editingRecordId) return;
    const epoch = accountEpoch;
    const id = editingRecordId;
    const request = ++profileEpoch;
    $('confirm-delete-btn').disabled = true;
    setHistoryBusy(true);
    try {
        await api('/medical-records/' + id, {method: 'DELETE'});
        if (epoch !== accountEpoch || request !== profileEpoch) return;
        recordListEpoch++;
        medicalRecords = medicalRecords.filter((record) => record.id !== id);
        if (selectedRecordId === id) {
            selectedRecordId = null;
            $('use-history').checked = false;
        }
        conversationList = conversationList.map((chat) => chat.medical_record_id === id
            ? {...chat, medical_record_id: null, use_history: false} : chat);
        beginMedicalRecord();
        $('history-status').textContent = 'Record deleted. Chats remain, but this history will no longer be used.';
        updateChatContext(); renderConversationList();
    } catch (error) {
        if (epoch === accountEpoch && request === profileEpoch) $('history-status').textContent = error.message;
    } finally {
        if (epoch === accountEpoch) {
            $('confirm-delete-btn').disabled = false;
            setHistoryBusy(false);
        }
    }
}

async function extractPhoto() {
    if ($('extract-btn').disabled) return;
    if (!selectedPhoto) { $('history-status').textContent = 'Choose or take a photo first.'; return; }
    if (!$('photo-consent').checked) { $('history-status').textContent = 'Please agree to send the photo to Groq before extracting text.'; return; }
    if (selectedPhoto.size > 5 * 1024 * 1024) { $('history-status').textContent = 'Choose a photo no larger than 5 MB.'; return; }
    const epoch = accountEpoch;
    const extraction = ++extractionEpoch;
    const body = new FormData();
    body.append('image', selectedPhoto);
    body.append('consent', 'true');
    $('extract-btn').disabled = true;
    $('extraction-review').hidden = true;
    $('extracted-fields').replaceChildren();
    $('transcription-details').open = false;
    $('extracted-text').textContent = '';
    $('history-status').textContent = 'Reading the document and organizing suggested fields…';
    try {
        const data = await api('/history/extract', { method: 'POST', body });
        if (epoch !== accountEpoch || extraction !== extractionEpoch) return;
        if (!data.history) throw new Error('This server does not support organized photo extraction yet.');
        $('extracted-text').textContent = data.text;
        for (const field of HISTORY_FIELDS) {
            const label = document.createElement('label');
            label.textContent = HISTORY_FIELD_LABELS[field];
            const input = document.createElement('textarea');
            input.id = extractedField(field);
            input.rows = 2;
            input.maxLength = $('history-form').elements[field].maxLength;
            input.value = data.history[field] || '';
            label.appendChild(input);
            $('extracted-fields').appendChild(label);
        }
        $('extraction-review').hidden = false;
        $('history-status').textContent = 'Review the suggested fields below before applying them.';
        $(extractedField(HISTORY_FIELDS[0])).focus();
    } catch (error) {
        if (epoch === accountEpoch && extraction === extractionEpoch) $('history-status').textContent = error.message;
    } finally { if (extraction === extractionEpoch) $('extract-btn').disabled = false; }
}

function applyReviewedFields() {
    if ($('extraction-review').hidden) return;
    const updates = [];
    for (const field of HISTORY_FIELDS) {
        const value = $(extractedField(field)).value.trim();
        if (!value) continue;
        const input = $('history-form').elements[field];
        const existing = input.value;
        if (existing.split(/\n{2,}/).some((entry) => entry.trim() === value)) continue;
        const combined = existing.trim() ? existing + '\n\n' + value : value;
        if (combined.length > input.maxLength) {
            $('history-status').textContent = `Shorten the suggested ${HISTORY_FIELD_LABELS[field].toLowerCase()} to fit the form.`;
            $(extractedField(field)).focus();
            return;
        }
        updates.push([input, combined]);
    }
    for (const [input, value] of updates) input.value = value;
    clearExtraction();
    $('history-status').textContent = updates.length
        ? 'Reviewed entries added. Select Save history to store them.'
        : 'No new entries to add.';
    (updates[0]?.[0] || $('extract-btn')).focus();
}

function doctorCard(doctor) {
    const card = document.createElement('article');
    card.className = 'doctor-card';
    const title = document.createElement('h3');
    title.textContent = doctor.name;
    card.appendChild(title);
    [
        `${doctor.specialty} · ${doctor.city}`,
        `${doctor.qualifications} · ${doctor.experience_years} years listed experience`,
        `Consultation fee: ₹${doctor.fee_inr} · Languages: ${doctor.languages.join(', ')}`,
        doctor.resume.replace(/^Fictional demonstration profile\.\s*/, '')
            .replace(/Qualifications and experience are invented for this demo\.?$/, '')
            .replace('simulated experience', 'listed experience').trim(),
        doctor.match_reason
    ].forEach((text) => { const p = document.createElement('p'); p.textContent = text; card.appendChild(p); });
    return card;
}

async function findDoctors(event) {
    if (event) event.preventDefault();
    const epoch = ++directoryEpoch;
    const params = new URLSearchParams();
    new FormData($('doctor-filters')).forEach((value, key) => { if (value) params.set(key, value); });
    $('doctors-status').textContent = 'Loading doctor profiles…';
    try {
        const data = await api('/doctors?' + params);
        if (epoch !== directoryEpoch) return;
        ['city', 'specialty'].forEach((field) => {
            const select = $('doctor-filters').elements[field];
            if (select.options.length === 1) (field === 'city' ? data.cities : data.specialties).forEach((value) => {
                const option = document.createElement('option'); option.value = value; option.textContent = value; select.appendChild(option);
            });
        });
        $('doctor-results').replaceChildren(...data.doctors.map(doctorCard));
        $('doctors-status').textContent = data.doctors.length ? `${data.doctors.length} matching profiles.` : 'No matching profiles. Try a specialty or change your filters.';
    } catch (error) { if (epoch === directoryEpoch) $('doctors-status').textContent = error.message; }
}

function fillInput(btn) { $('user-input').value = btn.innerText; $('user-input').focus(); }

function resetChat() {
    closePubMed();
    chatEpoch++;
    conversationOpenEpoch++;
    conversationOpening = false;
    currentConversationId = null;
    conversationRevision = 1;
    selectedRecordId = null;
    $('use-history').checked = false;
    $('retry-chat-save').hidden = true;
    $('save-chat-copy').hidden = true;
    $('active-chat-title').textContent = 'New chat';
    $('user-input').value = '';
    chatDirty = false;
    chatMutation++;
    chatHistory = [];
    isLoading = false;
    setSendState(false);
    updateChatContext();
    renderRecordChoices(); renderConversationList();
    renderWelcome();
}

function renderWelcome() {
    $('chat-box').replaceChildren($('welcome-template').content.cloneNode(true));
}

function toggleSidebar() { $('sidebar').classList.toggle('hidden'); }

function clearPubMed() {
    pubmedRequest?.abort();
    pubmedRequest = null;
    $('pubmed-query').value = '';
    $('pubmed-status').textContent = '';
    $('pubmed-results').replaceChildren();
    $('pubmed-submit').disabled = false;
}

function closePubMed() {
    if ($('pubmed-dialog').open) $('pubmed-dialog').close();
    clearPubMed();
}

function pubmedLink(source, label) {
    const link = document.createElement('a');
    link.href = `https://pubmed.ncbi.nlm.nih.gov/${source.pmid}/`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    return link;
}

function renderPubMed(data) {
    const results = $('pubmed-results');
    const sources = (data.sources || []).filter((source) => /^[0-9]+$/.test(source.pmid));
    const titles = {
        summarized: 'AI summary based on abstracts. Findings may not apply to an individual case.',
        insufficient: 'The abstracts did not provide enough relevant evidence to summarize this topic.',
        no_abstracts: 'PubMed found papers, but none included an abstract for the summary.',
        no_results: 'No PubMed results found. Try a broader research topic.',
        summary_unavailable: 'The AI summary is unavailable. You can still open the PubMed results below.'
    };
    $('pubmed-status').textContent = titles[data.status] || 'PubMed search complete.';
    if (data.findings?.length) {
        const findings = document.createElement('ul');
        data.findings.forEach((finding) => {
            const item = document.createElement('li');
            item.textContent = finding.text;
            sources.forEach((source, index) => {
                if (finding.pmids.includes(source.pmid)) {
                    item.append(' ', pubmedLink(source, `[${index + 1}]`));
                }
            });
            findings.appendChild(item);
        });
        results.appendChild(findings);
    }
    if (sources.length) {
        const heading = document.createElement('h3');
        heading.textContent = 'PubMed sources';
        const list = document.createElement('ol');
        sources.forEach((source) => {
            const item = document.createElement('li');
            item.appendChild(pubmedLink(source, source.title));
            if (source.year) item.append(` (${source.year})`);
            list.appendChild(item);
        });
        results.append(heading, list);
    }
}

async function submitPubMed(event) {
    event.preventDefault();
    if (pubmedRequest) return;
    const query = $('pubmed-query').value.trim();
    if (query.length < 3) {
        $('pubmed-status').textContent = 'Enter at least three characters.';
        return;
    }
    const request = new AbortController();
    pubmedRequest = request;
    $('pubmed-submit').disabled = true;
    $('pubmed-status').textContent = 'Searching PubMed and checking abstracts…';
    $('pubmed-results').replaceChildren();
    try {
        const data = await api('/research/pubmed', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }), signal: request.signal, credentials: 'omit'
        }, false);
        if (pubmedRequest === request) renderPubMed(data);
    } catch (error) {
        if (pubmedRequest === request) $('pubmed-status').textContent = error.message || 'PubMed search failed.';
    } finally {
        if (pubmedRequest === request) {
            pubmedRequest = null;
            $('pubmed-submit').disabled = false;
        }
    }
}

async function sendbtn() {
    if (isLoading || conversationOpening) return;
    if (chatHistory.length >= 198) {
        $('conversation-status').textContent = 'This chat is full. Start a new chat to continue; this conversation is kept.';
        return;
    }
    const userMessage = $('user-input').value.trim();
    if (!userMessage) return;
    if (userMessage.length > 8000) { $('user-input').setCustomValidity('Keep your message under 8,000 characters.'); $('user-input').reportValidity(); return; }
    $('welcome-screen')?.remove();
    appendMessage('user', userMessage, $('chat-box'));
    chatHistory.push({ role: 'user', content: userMessage });
    chatDirty = true; chatMutation++;
    $('active-chat-title').textContent = shortChatTitle(chatHistory);
    $('user-input').value = '';
    const epoch = chatEpoch;
    const typing = showTyping($('chat-box'));
    isLoading = true;
    setSendState(true);
    try {
        await saveCurrentConversation();
        if (epoch !== chatEpoch) return;
        const data = await api('/chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: chatHistory.slice(-39).map(({role, content}) => ({role, content: content.slice(0, 8000)})), use_history: Boolean(session && selectedRecordId && $('use-history').checked), medical_record_id: selectedRecordId })
        });
        if (epoch !== chatEpoch) return;
        typing.remove();
        appendMessage('assistant', data.reply, $('chat-box'));
        chatHistory.push({ role: 'assistant', content: data.reply,
            doctor_matches: (data.doctors || []).map((doctor) => ({id: doctor.id, reason: doctor.match_reason || ''})),
            used_history: Boolean(data.used_history), doctors: data.doctors || [] });
        chatDirty = true; chatMutation++;
        renderDoctorCards(data.doctors, data.used_history);
        await saveCurrentConversation();
    } catch (error) {
        if (epoch !== chatEpoch) return;
        typing.remove();
        appendMessage('assistant', error.message || 'Could not connect to PULSE. Please try again.', $('chat-box'));
        // Keep the real user message, but never save this transient error as an AI reply.
    } finally {
        if (epoch === chatEpoch) { isLoading = false; setSendState(false); $('chat-box').scrollTop = $('chat-box').scrollHeight; }
    }
}

function appendMessage(role, content, chatBox) {
    const div = document.createElement('div'); div.className = `message ${role}`;
    if (role === 'assistant' && window.marked && window.DOMPurify) {
        div.innerHTML = DOMPurify.sanitize(marked.parse(content));
        // Preserve readable columns on narrow screens without overflowing the chat.
        div.querySelectorAll('table').forEach((table) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'table-scroll';
            wrapper.tabIndex = 0;
            wrapper.setAttribute('role', 'region');
            wrapper.setAttribute('aria-label', 'Scrollable comparison table');
            table.replaceWith(wrapper);
            wrapper.appendChild(table);
        });
    }
    else div.textContent = content;
    chatBox.appendChild(div); chatBox.scrollTop = chatBox.scrollHeight;
}
function showTyping(chatBox) {
    const div = document.createElement('div'); div.className = 'message assistant typing-indicator';
    div.setAttribute('aria-label', 'PULSE is responding'); div.innerHTML = '<span></span><span></span><span></span>';
    chatBox.appendChild(div); return div;
}
function setSendState(loading) {
    document.querySelector('.send-btn').disabled = loading;
    $('chat-record-select').disabled = loading;
    $('use-history').disabled = loading;
    renderRecordChoices();
}


document.addEventListener('DOMContentLoaded', () => {
    renderWelcome();
    setEntryScreen(true);
    $('guest-btn').addEventListener('click', continueAsGuest);
    $('auth-dialog').addEventListener('cancel', (event) => {
        if (entryScreen) event.preventDefault();
    });
    $('auth-dialog').addEventListener('close', () => {
        if (entryScreen) showDialog('auth-dialog');
    });
    $('login-btn').addEventListener('click', login);
    $('auth-form').addEventListener('submit', submitAuth);
    $('login-mode-btn').addEventListener('click', () => setAuthMode('login'));
    $('signup-mode-btn').addEventListener('click', () => setAuthMode('signup'));
    $('forgot-mode-btn').addEventListener('click', () => setAuthMode('forgot'));
    $('auth-dialog').addEventListener('close', closeAuthDialog);
    $('logout-btn').addEventListener('click', logout);
    $('history-btn').addEventListener('click', () => { showDialog('history-dialog'); void loadHistory(); });
    $('history-form').addEventListener('submit', saveHistory);
    $('delete-history-btn').addEventListener('click', () => { $('delete-confirm').hidden = false; });
    $('cancel-delete-btn').addEventListener('click', () => { $('delete-confirm').hidden = true; });
    $('confirm-delete-btn').addEventListener('click', deleteHistory);
    $('extract-btn').addEventListener('click', extractPhoto);
    $('add-extracted-btn').addEventListener('click', applyReviewedFields);
    $('discard-extracted-btn').addEventListener('click', () => {
        clearExtraction();
        $('history-status').textContent = 'Suggestions discarded.';
        $('history-photo').focus();
    });
    $('history-dialog').addEventListener('close', clearExtraction);
    ['history-photo', 'history-camera'].forEach((id) => $(id).addEventListener('change', (event) => {
        const photo = event.target.files[0];
        clearExtraction(id);
        selectedPhoto = photo || null;
        $('history-status').textContent = photo ? `Selected ${photo.name}. Give consent, then extract text.` : '';
    }));
    $('doctors-btn').addEventListener('click', () => { showDialog('doctors-dialog'); void findDoctors(); });
    $('doctor-filters').addEventListener('submit', findDoctors);
    document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
    $('use-history').addEventListener('change', () => {
        if ($('use-history').checked && !selectedRecordId) {
            $('use-history').checked = false;
            $('conversation-status').textContent = 'Select a medical-history record first.';
        }
        void changeHistoryContext();
    });
    $('chat-record-select').addEventListener('change', changeHistoryContext);
    $('new-record-btn').addEventListener('click', beginMedicalRecord);
    $('more-chats-btn').addEventListener('click', () => void loadConversations(true));
    $('retry-chat-save').addEventListener('click', () => void saveCurrentConversation());
    $('pubmed-btn').addEventListener('click', () => { showDialog('pubmed-dialog'); $('pubmed-query').focus(); });
    $('pubmed-dialog').addEventListener('close', () => { if (!$('pubmed-dialog').open) clearPubMed(); });
    $('pubmed-form').addEventListener('submit', submitPubMed);
    $('save-chat-copy').addEventListener('click', () => void saveConversationCopy());
    $('confirm-delete-chat').addEventListener('click', deleteConversation);
    $('user-input').addEventListener('input', () => $('user-input').setCustomValidity(''));
    $('user-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendbtn(); } });
    void initializeAuth().catch(() => {
        $('account-status').textContent = 'Could not initialize sign-in. General chat remains available.';
        $('auth-status').textContent = 'Could not connect to sign-in. Try reloading, or continue as a guest.';
    });
});
document.addEventListener('click', (event) => {
    if (window.innerWidth <= 700 && !$('sidebar').classList.contains('hidden') && !$('sidebar').contains(event.target) && !event.target.closest('.menu-btn') && !event.target.closest('dialog')) $('sidebar').classList.add('hidden');
});
