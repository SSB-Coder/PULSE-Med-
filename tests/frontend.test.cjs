const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
    const elements = new Map();
    function element() {
        return { value: '', textContent: '', innerHTML: '', hidden: false, checked: false,
            disabled: false, open: false, children: [], style: {},
            appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); },
            replaceChildren(...children) { this.children = children; }, remove() { this.removed = true; },
            setAttribute() {}, focus() {}, setCustomValidity() {}, reportValidity() {},
            showModal() { this.open = true; }, close() { this.open = false; },
            classList: { toggle() {}, contains() { return false; }, add() {} }
        };
    }
    const get = (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    get('history-form').elements = Object.fromEntries(
        ['conditions', 'medications', 'allergies', 'surgeries', 'family_history', 'notes'].map(k => [k, element()])
    );
    const calls = [];
    const context = vm.createContext({
        window: { PULSE_CONFIG: { API_URL: 'https://api.example' }, location: { origin: 'https://app.example', pathname: '/', href: 'https://app.example/' }, history: { replaceState() {} } },
        document: { getElementById: get, createElement: element, querySelector: () => get('send-btn'), addEventListener() {} },
        Headers, FormData, URLSearchParams, URL, Blob, setTimeout,
        fetch: async (url, options) => { calls.push({ url, options }); return { status: 200, ok: true, json: async () => ({}) }; }
    });
    vm.runInContext(fs.readFileSync('frontend/app.js', 'utf8'), context);
    return { context, get, calls, run: (code) => vm.runInContext(code, context) };
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}


test('assistant markdown goes through sanitization; user text uses textContent', () => {
    const { context, get, run } = setup();
    const marked = { parse: (text) => `<b>${text}</b>` };
    const purifier = { sanitize: (html) => { assert.equal(html, '<b>unsafe</b>'); return '<b>safe</b>'; } };
    context.marked = context.window.marked = marked;
    context.DOMPurify = context.window.DOMPurify = purifier;
    run("appendMessage('assistant', 'unsafe', $('chat-box'))");
    assert.equal(get('chat-box').children[0].innerHTML, '<b>safe</b>');
    run("appendMessage('user', '<img onerror=alert(1)>', $('chat-box'))");
    assert.equal(get('chat-box').children[1].textContent, '<img onerror=alert(1)>');
    assert.equal(get('chat-box').children[1].innerHTML, '');
});

test('switching accounts clears medical form, history opt-in, and prior chat', () => {
    const { get, run } = setup();
    run("session = { user: {id: 'old-account'} }; chatHistory = [{role:'user', content:'private history'}]");
    get('history-form').elements.notes.value = 'private notes';
    get('use-history').checked = true;
    run('applySession(null)');
    assert.equal(get('history-form').elements.notes.value, '');
    assert.equal(get('use-history').checked, false);
    assert.equal(run('chatHistory.length'), 0);
    assert.equal(get('history-btn').hidden, true);
});

test('late chat response cannot reappear after conversation reset', async () => {
    const { context, get, run } = setup();
    const request = deferred();
    context.fetch = () => request.promise;
    get('user-input').value = 'private question';
    const sending = run('sendbtn()');
    run('resetChat()');
    request.resolve({ status: 200, ok: true, json: async () => ({ reply: 'old private response', doctors: [] }) });
    await sending;
    assert.equal(run('chatHistory.length'), 0);
    assert.equal(get('chat-box').children.some(n => n.textContent === 'old private response'), false);
});

test('photo extraction requires consent and never saves unreviewed text', async () => {
    const { context, get, calls, run } = setup();
    run("session = {access_token:'token', user:{id:'account'}}; selectedPhoto = new Blob(['photo'])");
    await run('extractPhoto()');
    assert.equal(calls.length, 0);
    assert.match(get('history-status').textContent, /agree/);
    get('photo-consent').checked = true;
    context.fetch = async (url, options) => {
        calls.push({ url, options });
        return { status: 200, ok: true, json: async () => ({ text: 'Medication: [unclear]', requires_review: true }) };
    };
    await run('extractPhoto()');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.example/history/extract');
    assert.equal(get('extracted-text').value, 'Medication: [unclear]');
    assert.equal(get('history-form').elements.notes.value, '');
    get('extracted-text').value = 'Reviewed medication text';
    run('addReviewedText()');
    assert.equal(get('history-form').elements.notes.value, 'Reviewed medication text');
    assert.equal(calls.length, 1, 'Reviewing text still must not persist it');
    await run('saveHistory({preventDefault(){}})');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.method, 'PUT');
    assert.equal(JSON.parse(calls[1].options.body).history.notes, 'Reviewed medication text');
});

test('late photo response cannot expose text after account change', async () => {
    const { context, get, run } = setup();
    const request = deferred();
    context.fetch = () => request.promise;
    run("session = {access_token:'token', user:{id:'account'}}; selectedPhoto = new Blob(['photo'])");
    get('photo-consent').checked = true;
    const extracting = run('extractPhoto()');
    run('applySession(null)');
    request.resolve({ status: 200, ok: true, json: async () => ({ text: 'private transcription' }) });
    await extracting;
    assert.equal(get('extracted-text').value, '');
    assert.equal(get('extraction-review').hidden, true);
});

function mockAuth(context, run, methods) {
    context.mockAuthClient = { auth: methods };
    run('authClient = mockAuthClient');
}

function fillCredentials(get, password = 'a-long-test-password') {
    get('auth-email').value = 'test@example.com';
    get('auth-password').value = password;
    get('auth-confirm').value = password;
}

test('email login delegates credentials to Supabase and clears password fields', async () => {
    const { context, get, calls, run } = setup();
    const credentials = [];
    mockAuth(context, run, { signInWithPassword: async (input) => {
        credentials.push(input);
        return { data: { session: { access_token: 'token', user: { id: 'user', email: input.email } } }, error: null };
    } });
    fillCredentials(get, 'old-pass'); // Existing passwords aren't rejected by the new-account length rule.
    await run('submitAuth({preventDefault(){}})');
    assert.equal(credentials[0].email, 'test@example.com');
    assert.equal(credentials[0].password, 'old-pass');
    assert.equal(run('session.user.id'), 'user');
    assert.equal(get('auth-password').value, '');
    assert.equal(get('auth-confirm').value, '');
    assert.equal(calls.some(call => JSON.stringify(call.options).includes('old-pass')), false);
});

test('signup validates length and confirmation before contacting Supabase', async () => {
    const { context, get, run } = setup();
    let requests = 0;
    mockAuth(context, run, { signUp: async () => { requests++; return { data: {}, error: null }; } });
    run("setAuthMode('signup')");
    fillCredentials(get, 'short');
    await run('submitAuth({preventDefault(){}})');
    assert.equal(requests, 0);
    assert.match(get('auth-status').textContent, /12 characters/);
    fillCredentials(get);
    get('auth-confirm').value = 'different-password';
    await run('submitAuth({preventDefault(){}})');
    assert.equal(requests, 0);
    assert.match(get('auth-status').textContent, /do not match/);
});

test('signup with email confirmation does not pretend the user is logged in', async () => {
    const { context, get, run } = setup();
    mockAuth(context, run, { signUp: async (input) => {
        assert.equal(input.options.emailRedirectTo, 'https://app.example/');
        return { data: { session: null }, error: null };
    } });
    run("setAuthMode('signup')");
    fillCredentials(get);
    await run('submitAuth({preventDefault(){}})');
    assert.equal(run('session'), null);
    assert.match(get('auth-status').textContent, /confirmation link/);
    assert.equal(get('auth-password').value, '');
    assert.equal(run('authBusy'), false);
});

test('failed password login shows a generic error and clears credentials', async () => {
    const { context, get, run } = setup();
    mockAuth(context, run, { signInWithPassword: async () => ({ error: { message: 'private provider error', code: 'invalid_credentials' } }) });
    fillCredentials(get);
    await run('submitAuth({preventDefault(){}})');
    assert.equal(run('session'), null);
    assert.match(get('auth-status').textContent, /Could not log in/);
    assert.equal(get('auth-status').textContent.includes('private provider error'), false);
    assert.equal(get('auth-password').value, '');
});

test('forgot-password request is generic and uses the recovery redirect', async () => {
    const { context, get, run } = setup();
    mockAuth(context, run, { resetPasswordForEmail: async (email, options) => {
        assert.equal(email, 'test@example.com');
        assert.equal(options.redirectTo, 'https://app.example/?auth=recovery');
        return { error: null };
    } });
    run("setAuthMode('forgot')");
    get('auth-email').value = 'test@example.com';
    await run('submitAuth({preventDefault(){}})');
    assert.match(get('auth-status').textContent, /If this email has an account/);
    assert.equal(get('auth-password').required, false);
});

test('password update requires a session and sends only the new password to Supabase', async () => {
    const { context, get, run } = setup();
    let requests = 0;
    mockAuth(context, run, { updateUser: async (input) => {
        requests++;
        assert.deepEqual(Object.keys(input), ['password']);
        assert.equal(input.password, 'a-long-test-password');
        return { error: null };
    } });
    run("setAuthMode('update')");
    fillCredentials(get);
    await run('submitAuth({preventDefault(){}})');
    assert.equal(requests, 0);
    assert.match(get('auth-status').textContent, /new reset link/);
    run("session = {access_token:'token', user:{id:'user'}}");
    await run('submitAuth({preventDefault(){}})');
    assert.equal(requests, 1);
    assert.equal(get('auth-password').value, '');
    assert.match(get('account-status').textContent, /Password updated/);
});

test('recovery URL initialization opens password update without opening history', async () => {
    const { context, get, run, calls } = setup();
    context.window.location.href = 'https://app.example/?auth=recovery';
    context.window.PULSE_CONFIG.SUPABASE_URL = 'https://project.supabase.co';
    context.window.PULSE_CONFIG.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
    const recovered = { access_token: 'token', user: { id: 'recovered-user', email: 'test@example.com' } };
    let subscribed = false;
    context.window.supabase = { createClient: () => ({ auth: {
        onAuthStateChange: () => { subscribed = true; },
        getSession: async () => {
            assert.equal(subscribed, true, 'Subscribe before URL session processing');
            return { data: { session: recovered }, error: null };
        }
    } }) };
    await run('initializeAuth()');
    assert.equal(run('authMode'), 'update');
    assert.equal(get('auth-dialog').open, true);
    assert.equal(get('history-dialog').open, false);
    assert.equal(calls.length, 0);
});

test('closing login clears passwords and ignores its delayed form response', async () => {
    const { context, get, run } = setup();
    const pending = deferred();
    mockAuth(context, run, { signInWithPassword: () => pending.promise });
    fillCredentials(get);
    const submitting = run('submitAuth({preventDefault(){}})');
    run('closeAuthDialog()');
    pending.resolve({ error: { code: 'invalid_credentials' } });
    await submitting;
    assert.equal(get('auth-password').value, '');
    assert.equal(get('auth-confirm').value, '');
    assert.equal(run('authBusy'), false);
    assert.equal(get('auth-status').textContent.includes('Could not log in'), false);
});
