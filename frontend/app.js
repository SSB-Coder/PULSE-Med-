const config = window.PULSE_CONFIG || {};
const API_URL = (config.API_URL || window.location.origin).replace(/\/$/, '');
const HISTORY_FIELDS = ['conditions', 'medications', 'allergies', 'surgeries', 'family_history', 'notes'];
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
const $ = (id) => document.getElementById(id);

function updateChatContext() {
    const useHistory = Boolean(session && $('use-history').checked);
    $('session-badge').textContent = session ? 'Signed in' : 'Guest session';
    $('chat-context').textContent = useHistory
        ? 'History enabled · Replies and demo doctor matches use your saved history and current symptoms.'
        : session ? 'History off · Doctor matches use this conversation. Enable saved history in the sidebar to include it.'
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

async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (session) headers.set('Authorization', `Bearer ${session.access_token}`);
    const response = await fetch(API_URL + path, { ...options, headers, cache: 'no-store' });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status}).`);
    return data;
}

function clearExtraction(preserveInputId = null) {
    extractionEpoch++;
    selectedPhoto = null;
    ['history-photo', 'history-camera'].forEach((id) => { if (id !== preserveInputId) $(id).value = ''; });
    $('photo-consent').checked = false;
    $('extracted-text').value = '';
    $('extraction-review').hidden = true;
    $('extract-btn').disabled = false;
}

function populateHistory(history = {}) {
    HISTORY_FIELDS.forEach((field) => { $('history-form').elements[field].value = history[field] || ''; });
    clearExtraction();
    $('delete-confirm').hidden = true;
}

function showDialog(id) { if (!$(id).open) $(id).showModal(); }

async function loadHistory(openWhenEmpty = false) {
    const epoch = accountEpoch;
    const request = ++profileEpoch;
    $('history-form').inert = true;
    $('history-status').textContent = 'Loading your saved history…';
    try {
        const data = await api('/profile');
        if (epoch !== accountEpoch || request !== profileEpoch) return;
        populateHistory(data.profile?.history || {});
        $('history-status').textContent = data.profile ? 'Your saved history is ready to edit.' : 'Add your history now, or skip and return later.';
        if (openWhenEmpty && !data.profile && !recoveringPassword) showDialog('history-dialog');
    } catch (error) {
        if (epoch === accountEpoch && request === profileEpoch) $('history-status').textContent = error.message;
    } finally {
        if (epoch === accountEpoch && request === profileEpoch) $('history-form').inert = false;
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
    $('account-status').textContent = signedIn ? `Signed in as ${session.user.email || 'your account'}` : 'Sign in to save your optional medical history.';
    if (previousId !== session?.user.id) {
        accountEpoch++;
        profileEpoch++;
        clearPasswords();
        if (!signedIn) {
            recoveringPassword = false;
            if (guestMode) $('auth-dialog').close();
        }
        $('history-form').inert = false;
        $('use-history').checked = false;
        populateHistory();
        $('history-dialog').close();
        resetChat();
        if (signedIn && !recoveringPassword) void loadHistory(true);
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
        $('account-status').textContent = 'Account setup pending. General chat and demo doctors are available.';
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
        if (session) void loadHistory(true);
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
    const epoch = accountEpoch;
    const history = Object.fromEntries(HISTORY_FIELDS.map((field) => [field, $('history-form').elements[field].value.trim()]));
    $('save-history-btn').disabled = true;
    try {
        await api('/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ history }) });
        if (epoch !== accountEpoch) return;
        clearExtraction();
        resetChat();
        $('history-status').textContent = 'History saved. Enable the saved-history option in the sidebar to use it for replies and doctor suggestions. Your conversation has been reset.';
    } catch (error) {
        if (epoch === accountEpoch) $('history-status').textContent = error.message;
    } finally { $('save-history-btn').disabled = false; }
}

async function deleteHistory() {
    const epoch = accountEpoch;
    $('confirm-delete-btn').disabled = true;
    try {
        await api('/profile', { method: 'DELETE' });
        if (epoch !== accountEpoch) return;
        populateHistory();
        $('use-history').checked = false;
        resetChat();
        $('history-status').textContent = 'Saved history deleted. Chat was cleared on this device.';
    } catch (error) {
        if (epoch === accountEpoch) $('history-status').textContent = error.message;
    } finally { $('confirm-delete-btn').disabled = false; }
}

async function extractPhoto() {
    if (!selectedPhoto) { $('history-status').textContent = 'Choose or take a photo first.'; return; }
    if (!$('photo-consent').checked) { $('history-status').textContent = 'Please agree to send the photo to Groq before extracting text.'; return; }
    if (selectedPhoto.size > 5 * 1024 * 1024) { $('history-status').textContent = 'Choose a photo no larger than 5 MB.'; return; }
    const epoch = accountEpoch;
    const extraction = ++extractionEpoch;
    const body = new FormData();
    body.append('image', selectedPhoto);
    body.append('consent', 'true');
    $('extract-btn').disabled = true;
    $('history-status').textContent = 'Extracting text. You will review it before saving.';
    try {
        const data = await api('/history/extract', { method: 'POST', body });
        if (epoch !== accountEpoch || extraction !== extractionEpoch) return;
        $('extracted-text').value = data.text;
        $('extraction-review').hidden = false;
        $('history-status').textContent = 'Review the transcription below. It has not been saved.';
        $('extracted-text').focus();
    } catch (error) {
        if (epoch === accountEpoch && extraction === extractionEpoch) $('history-status').textContent = error.message;
    } finally { if (extraction === extractionEpoch) $('extract-btn').disabled = false; }
}

function addReviewedText() {
    const text = $('extracted-text').value.trim();
    if (!text) { $('history-status').textContent = 'Enter or correct the transcription first.'; return; }
    const notes = $('history-form').elements.notes;
    const combined = [notes.value.trim(), text].filter(Boolean).join('\n\n');
    if (combined.length > 12000) { $('history-status').textContent = 'Notes are limited to 12,000 characters. Shorten the text before adding it.'; return; }
    notes.value = combined;
    clearExtraction();
    $('history-status').textContent = 'Reviewed text added to notes. Select Save history to store it.';
    notes.focus();
}

function doctorCard(doctor) {
    const card = document.createElement('article');
    card.className = 'doctor-card';
    const label = document.createElement('span');
    label.className = 'demo-label';
    label.textContent = 'FICTIONAL DEMO PROFILE';
    card.appendChild(label);
    const title = document.createElement('h3');
    title.textContent = doctor.name;
    card.appendChild(title);
    [
        `${doctor.specialty} · ${doctor.city}`,
        `${doctor.qualifications} · ${doctor.experience_years} simulated years`,
        `Demo fee: ₹${doctor.fee_inr} · Languages: ${doctor.languages.join(', ')}`,
        doctor.resume, doctor.match_reason, 'Demo only — no real appointments or verified credentials.'
    ].forEach((text) => { const p = document.createElement('p'); p.textContent = text; card.appendChild(p); });
    return card;
}

async function findDoctors(event) {
    if (event) event.preventDefault();
    const epoch = ++directoryEpoch;
    const params = new URLSearchParams();
    new FormData($('doctor-filters')).forEach((value, key) => { if (value) params.set(key, value); });
    $('doctors-status').textContent = 'Loading demo profiles…';
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
        $('doctors-status').textContent = data.doctors.length ? `${data.doctors.length} fictional matches. These are directory matches, not clinical referrals.` : 'No matching demo profiles. Try a specialty or change your filters.';
    } catch (error) { if (epoch === directoryEpoch) $('doctors-status').textContent = error.message; }
}

function fillInput(btn) { $('user-input').value = btn.innerText; $('user-input').focus(); }

function resetChat() {
    chatEpoch++;
    chatHistory = [];
    isLoading = false;
    setSendState(false);
    updateChatContext();
    $('chat-box').innerHTML = `<div class="welcome-screen" id="welcome-screen">
        <div class="welcome-icon">🩺</div><h2>Welcome to PULSE</h2>
        <p>Tell us your current symptoms and how long they have lasted. PULSE will explain what it can and show matching fictional doctor profiles. You choose whether to include saved medical history.</p>
        <div class="suggestion-chips">
        <button class="chip" onclick="fillInput(this)">I have recurring headaches. Who could I consult?</button>
        <button class="chip" onclick="fillInput(this)">Find a doctor for migraines</button>
        </div></div>`;
}

function toggleSidebar() { $('sidebar').classList.toggle('hidden'); }

async function sendbtn() {
    if (isLoading) return;
    const userMessage = $('user-input').value.trim();
    if (!userMessage) return;
    if (userMessage.length > 8000) { $('user-input').setCustomValidity('Keep your message under 8,000 characters.'); $('user-input').reportValidity(); return; }
    $('welcome-screen')?.remove();
    appendMessage('user', userMessage, $('chat-box'));
    chatHistory.push({ role: 'user', content: userMessage });
    $('user-input').value = '';
    const epoch = chatEpoch;
    const typing = showTyping($('chat-box'));
    isLoading = true;
    setSendState(true);
    try {
        const data = await api('/chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: chatHistory.slice(-39), use_history: Boolean(session && $('use-history').checked) })
        });
        if (epoch !== chatEpoch) return;
        typing.remove();
        appendMessage('assistant', data.reply, $('chat-box'));
        chatHistory.push({ role: 'assistant', content: data.reply });
        if (data.doctors?.length) {
            const cards = document.createElement('div'); cards.className = 'doctor-results';
            const heading = document.createElement('h3');
            heading.className = 'doctor-results-title';
            heading.textContent = 'Doctor profiles to explore';
            const basis = document.createElement('p');
            basis.className = 'small-text';
            basis.textContent = data.used_history
                ? 'Matched against this conversation and your shared history. Fictional profiles; no appointments.'
                : 'Matched against this conversation. Fictional profiles; no appointments.';
            cards.append(heading, basis, ...data.doctors.map(doctorCard)); $('chat-box').appendChild(cards);
        }
    } catch (error) {
        if (epoch !== chatEpoch) return;
        typing.remove();
        appendMessage('assistant', error.message || 'Could not connect to PULSE. Please try again.', $('chat-box'));
        // Failed requests do not add invented assistant messages to the model's history.
        chatHistory.pop();
    } finally {
        if (epoch === chatEpoch) { isLoading = false; setSendState(false); $('chat-box').scrollTop = $('chat-box').scrollHeight; }
    }
}

function appendMessage(role, content, chatBox) {
    const div = document.createElement('div'); div.className = `message ${role}`;
    if (role === 'assistant' && window.marked && window.DOMPurify) div.innerHTML = DOMPurify.sanitize(marked.parse(content));
    else div.textContent = content;
    chatBox.appendChild(div); chatBox.scrollTop = chatBox.scrollHeight;
}
function showTyping(chatBox) {
    const div = document.createElement('div'); div.className = 'message assistant typing-indicator';
    div.setAttribute('aria-label', 'PULSE is responding'); div.innerHTML = '<span></span><span></span><span></span>';
    chatBox.appendChild(div); return div;
}
function setSendState(loading) { const btn = document.querySelector('.send-btn'); btn.disabled = loading; }


document.addEventListener('DOMContentLoaded', () => {
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
    $('add-extracted-btn').addEventListener('click', addReviewedText);
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
    $('use-history').addEventListener('change', resetChat);
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
