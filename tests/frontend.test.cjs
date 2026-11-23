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
            addEventListener() {}, querySelectorAll() { return []; }, setAttribute() {}, focus() {}, setCustomValidity() {}, reportValidity() {},
            showModal() { this.open = true; }, close() { this.open = false; },
            classList: { toggle() {}, contains() { return false; }, add() {} }
        };
    }
    const get = (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    get('history-form').elements = Object.fromEntries(
        ['conditions', 'medications', 'allergies', 'surgeries', 'family_history', 'notes'].map(k => [k, element()])
    );
    const limits = { conditions: 3000, medications: 3000, allergies: 2000, surgeries: 2000, family_history: 2000, notes: 12000 };
    for (const [field, limit] of Object.entries(limits)) get('history-form').elements[field].maxLength = limit;
    const welcome = {kind: 'welcome-template-copy'};
    get('welcome-template').content = {cloneNode: () => welcome};
    function createElement() {
        const node = element();
        Object.defineProperty(node, 'id', {set(id) { elements.set(id, node); }});
        return node;
    }
    const calls = [];
    const context = vm.createContext({
        window: { PULSE_CONFIG: { API_URL: 'https://api.example' }, location: { origin: 'https://app.example', pathname: '/', href: 'https://app.example/' }, history: { replaceState() {} } },
        document: { body: element(), getElementById: get, createElement, querySelector: () => get('send-btn'), addEventListener() {} },
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
        return { status: 200, ok: true, json: async () => ({ text: 'Medication: [unclear]', history: {medications: '[unclear]', family_history: 'Mother has asthma'}, requires_review: true }) };
    };
    await run('extractPhoto()');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.example/history/extract');
    assert.equal(get('extracted-text').textContent, 'Medication: [unclear]');
    const form = get('history-form').elements;
    assert.equal(form.medications.value, '');
    form.medications.value = 'Existing medication';
    form.allergies.value = 'Penicillin: rash';
    get('extracted-medications').value = 'Reviewed medication text';
    run('applyReviewedFields()');
    assert.equal(form.medications.value, 'Existing medication\n\nReviewed medication text');
    assert.equal(form.family_history.value, 'Mother has asthma');
    assert.equal(form.allergies.value, 'Penicillin: rash');
    assert.equal(form.notes.value, '');
    assert.equal(calls.length, 1, 'Reviewing text still must not persist it');
    get('record-name').value = 'Reviewed report';
    await run('saveHistory({preventDefault(){}})');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[1].url, 'https://api.example/medical-records');
    assert.equal(JSON.parse(calls[1].options.body).history.medications, 'Existing medication\n\nReviewed medication text');
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
    assert.equal(get('extracted-text').textContent, '');
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

test('entry screen requires login or an explicit guest choice, including when auth is unavailable', async () => {
    const { get, run } = setup();
    run('setEntryScreen(true)');
    await run('initializeAuth()');
    assert.equal(get('app-shell').hidden, true);
    assert.equal(get('auth-dialog').open, true);
    assert.equal(get('auth-close-btn').hidden, true);
    assert.equal(get('auth-submit').disabled, true);
    run('continueAsGuest()');
    assert.equal(get('app-shell').hidden, false);
    assert.equal(get('auth-dialog').open, false);
    assert.equal(run('session'), null);
    assert.match(get('chat-context').textContent, /Guest mode/);
    // A delayed empty session event must not send a guest back to login.
    run('applySession(null)');
    assert.equal(get('app-shell').hidden, false);
});

test('restored session enters the app and sign-out returns to login with consent reset', () => {
    const { get, run } = setup();
    run('setEntryScreen(true)');
    run("applySession({access_token:'token', user:{id:'account', email:'test@example.com'}})");
    assert.equal(get('app-shell').hidden, false);
    assert.equal(get('auth-dialog').open, false);
    get('use-history').checked = true;
    run("selectedRecordId = 'record-a'; updateChatContext()");
    assert.match(get('chat-context').textContent, /History enabled/);
    run('applySession(null)');
    assert.equal(get('app-shell').hidden, true);
    assert.equal(get('auth-dialog').open, true);
    assert.equal(get('use-history').checked, false);
    assert.equal(run('chatHistory.length'), 0);
});

test('sanitized Markdown tables receive a keyboard-accessible horizontal scroll wrapper', () => {
    const { context, get, run } = setup();
    let wrapper;
    const table = { replaceWith(node) { wrapper = node; } };
    context.window.marked = context.marked = { parse: () => '<table><tr><td>Doctor</td></tr></table>' };
    context.window.DOMPurify = context.DOMPurify = { sanitize: (html) => html };
    const baseCreate = context.document.createElement;
    context.document.createElement = () => {
        const element = baseCreate();
        element.querySelectorAll = () => [table];
        element.attributes = {};
        element.setAttribute = (key, value) => { element.attributes[key] = value; };
        return element;
    };
    run("appendMessage('assistant', 'comparison', $('chat-box'))");
    assert.equal(wrapper.className, 'table-scroll');
    assert.equal(wrapper.tabIndex, 0);
    assert.equal(wrapper.attributes.role, 'region');
    assert.equal(wrapper.attributes['aria-label'], 'Scrollable comparison table');
    assert.equal(wrapper.children[0], table);
    assert.match(get('chat-box').children[0].innerHTML, /<table>/);
});

test('chat titles use a concise first-message subject without a title model request', () => {
    const { run } = setup();
    assert.equal(run("shortChatTitle([{role:'user',content:'I have recurring headaches. Who could I consult?'}])"), 'Recurring headaches');
    assert.equal(run("shortChatTitle([{role:'user',content:'Please help me understand symptoms of diabetes'}])"), 'Symptoms of diabetes');
    assert.equal(run("shortChatTitle([{role:'user',content:'???'}])"), 'New chat');
    assert.ok(run("shortChatTitle([{role:'user',content:'x'.repeat(100)}]).length") <= 60);
});

test('signed-in chat saves, reopens with its own selected record, and continues under the same id', async () => {
    const { context, get, run } = setup();
    let saved;
    const requests = [];
    context.fetch = async (url, options = {}) => {
        requests.push({url,options});
        let data;
        if (url.endsWith('/chat')) data = {reply:'Let us discuss the symptoms.',doctors:[],used_history:true};
        else if (url.endsWith('/medical-records')) data = {records:[{id:'record-a',name:'General history'},{id:'record-b',name:'Recent checkup'}]};
        else if (options.method === 'POST' || options.method === 'PUT') {
            const body = JSON.parse(options.body);
            saved = {...body,id:'chat-a',title:'Recurring headaches',revision:saved ? saved.revision+1 : 1};
            data = {conversation:saved};
        } else data = {conversation:saved};
        return {status:200,ok:true,json:async()=>data};
    };
    run("session={access_token:'token',user:{id:'user'}}; medicalRecords=[{id:'record-a',name:'General history'},{id:'record-b',name:'Recent checkup'}]; selectedRecordId='record-a'");
    get('use-history').checked = true;
    get('user-input').value = 'I have recurring headaches. Who could I consult?';
    await run('sendbtn()');
    assert.equal(run('currentConversationId'), 'chat-a');
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.medical_record_id, 'record-a');
    assert.equal(saved.use_history, true);
    assert.equal(requests.length, 3, 'Save, infer, save; no separate title-generation request');
    const chatPayload = JSON.parse(requests[1].options.body);
    assert.equal(chatPayload.medical_record_id, 'record-a');
    assert.deepEqual(Object.keys(chatPayload.messages[0]), ['role','content']);
    await run('newChat()');
    assert.equal(run('selectedRecordId'), null);
    assert.equal(run('conversationList.length'), 1);
    await run("openConversation('chat-a')");
    assert.equal(run('chatHistory.length'), 2);
    assert.equal(run('selectedRecordId'), 'record-a');
    assert.equal(get('use-history').checked, true);
    assert.equal(get('active-chat-title').textContent, 'Recurring headaches');
    get('chat-record-select').value = 'record-b';
    await run('changeHistoryContext()');
    assert.equal(saved.medical_record_id, 'record-b');
    assert.equal(saved.messages.length, 2, 'Changing the main history must keep chat messages');
    get('user-input').value = 'It started yesterday';
    await run('sendbtn()');
    assert.equal(run('currentConversationId'), 'chat-a');
    assert.equal(saved.messages.length, 4);
    assert.equal(saved.medical_record_id, 'record-b');
});

test('multiple records save independently; reviewed text is kept in its named record', async () => {
    const { context, get, run } = setup();
    const saved = [];
    context.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        const record = {id:'record-'+(saved.length+1),...body};
        saved.push(record);
        return {status:201,ok:true,json:async()=>({record})};
    };
    run("session={access_token:'token',user:{id:'user'}}; beginMedicalRecord()");
    get('record-name').value = 'General history';
    get('history-form').elements.conditions.value = 'Hypertension';
    await run('saveHistory({preventDefault(){}})');
    run('beginMedicalRecord()');
    get('record-name').value = 'November report';
    get('extraction-review').hidden = false;
    get('extracted-notes').value = 'Reviewed report text';
    run('applyReviewedFields()');
    await run('saveHistory({preventDefault(){}})');
    assert.equal(saved.length, 2);
    assert.equal(saved[0].history.conditions, 'Hypertension');
    assert.equal(saved[1].history.conditions, '');
    assert.equal(saved[1].history.notes, 'Reviewed report text');
    assert.equal(run('medicalRecords.length'), 2);
    assert.equal(run('selectedRecordId'), null, 'Saving must not implicitly consent to sharing');
});

test('guest conversations reopen in memory without account-storage calls', async () => {
    const { context, get, run } = setup();
    let requests = 0;
    context.fetch = async (url) => {
        assert.equal(url,'https://api.example/chat'); requests++;
        return {status:200,ok:true,json:async()=>({reply:'A reply',doctors:[]})};
    };
    get('user-input').value = 'Tell me about sleep';
    await run('sendbtn()');
    const id = run('currentConversationId');
    await run('newChat()');
    await run(`openConversation('${id}')`);
    assert.equal(run('chatHistory.length'), 2);
    assert.equal(requests, 1);
    assert.match(get('conversation-status').textContent, /this visit only/);
});

test('failed saves preserve the conversation and block navigation until retry succeeds', async () => {
    const { context, get, run } = setup();
    run("session={access_token:'token',user:{id:'user'}}; chatHistory=[{role:'user',content:'Private question'}]; chatDirty=true");
    context.fetch = async () => ({status:503,ok:false,json:async()=>({detail:'Storage temporarily unavailable'})});
    await run('newChat()');
    assert.equal(run('chatHistory.length'), 1);
    assert.equal(get('retry-chat-save').hidden, false);
    assert.match(get('conversation-status').textContent,/not saved/);
    context.fetch = async () => ({status:201,ok:true,json:async()=>({conversation:{id:'saved-chat',revision:1,title:'Private question'}})});
    await run('newChat()');
    assert.equal(run('chatHistory.length'), 0);
    assert.equal(run('conversationList[0].id'), 'saved-chat');
});

test('late conversation reads and saves cannot expose another account’s data', async () => {
    const { context, get, run } = setup();
    const pending = deferred();
    run("session={access_token:'token',user:{id:'old'}}");
    context.fetch = () => pending.promise;
    const opening = run("openConversation('private-chat')");
    run('applySession(null)');
    pending.resolve({status:200,ok:true,json:async()=>({conversation:{id:'private-chat',title:'Private diagnosis',messages:[{role:'user',content:'Private data'}]}})});
    await opening;
    assert.equal(run('chatHistory.length'), 0);
    assert.equal(run('conversationList.length'), 0);
    assert.notEqual(get('active-chat-title').textContent,'Private diagnosis');
    const saving = deferred();
    context.fetch = () => saving.promise;
    run("session={access_token:'token',user:{id:'old'}}; chatHistory=[{role:'user',content:'Private data'}]; chatDirty=true");
    const save = run('saveCurrentConversation()');
    run('applySession(null)');
    saving.resolve({status:201,ok:true,json:async()=>({conversation:{id:'private-chat',title:'Private diagnosis',revision:1}})});
    await save;
    assert.equal(run('currentConversationId'), null);
    assert.equal(run('conversationList.length'), 0);
});

test('deleting a selected medical record detaches it without clearing chat messages', async () => {
    const { context, get, run } = setup();
    context.fetch = async (url, options) => {
        assert.equal(url, 'https://api.example/medical-records/record-a');
        assert.equal(options.method,'DELETE');
        return {status:204,ok:true};
    };
    run("session={access_token:'token',user:{id:'user'}}; medicalRecords=[{id:'record-a',name:'History'}]; editingRecordId='record-a'; selectedRecordId='record-a'; currentConversationId='chat-a'; chatHistory=[{role:'user',content:'Prior question'}]");
    get('use-history').checked = true;
    await run('deleteHistory()');
    assert.equal(run('selectedRecordId'),null);
    assert.equal(get('use-history').checked,false);
    assert.equal(run('chatHistory.length'),1);
    assert.equal(run('currentConversationId'),'chat-a');
    assert.equal(run('medicalRecords.length'),0);
});

test('a late record-list response cannot hide a newly saved record', async () => {
    const { context, get, run } = setup();
    const stale = deferred();
    context.fetch = async (url, options={}) => options.method === 'POST'
        ? {status:201,ok:true,json:async()=>({record:{id:'record-a',name:'New history',history:{}}})}
        : stale.promise;
    run("session={access_token:'token',user:{id:'user'}}");
    const loading = run('loadHistory()');
    get('record-name').value = 'New history';
    await run('saveHistory({preventDefault(){}})');
    stale.resolve({status:200,ok:true,json:async()=>({records:[]})});
    await loading;
    assert.equal(run('medicalRecords.length'),1);
    assert.equal(run('medicalRecords[0].id'),'record-a');
});

test('conflicting saves can be kept as a separate chat without overwriting the remote chat', async () => {
    const { context, get, run } = setup();
    run("session={access_token:'token',user:{id:'user'}}; currentConversationId='original'; conversationRevision=1; chatHistory=[{role:'user',content:'Local changes'}]; chatDirty=true");
    context.fetch = async () => ({status:409,ok:false,json:async()=>({detail:'Changed in another tab'})});
    assert.equal(await run('saveCurrentConversation()'),false);
    assert.equal(get('save-chat-copy').hidden,false);
    context.fetch = async (url, options) => {
        assert.equal(url,'https://api.example/conversations');
        assert.equal(options.method,'POST');
        return {status:201,ok:true,json:async()=>({conversation:{id:'copy',revision:1,title:'Local changes'}})};
    };
    assert.equal(await run('saveConversationCopy()'),true);
    assert.equal(run('currentConversationId'),'copy');
    assert.equal(run('chatHistory[0].content'),'Local changes');
});


test('an overlong merged field leaves every form field unchanged until corrected', () => {
    const {get, run} = setup();
    const form = get('history-form').elements;
    form.allergies.value = 'a'.repeat(form.allergies.maxLength);
    get('extraction-review').hidden = false;
    get('extracted-conditions').value = 'Asthma';
    get('extracted-allergies').value = 'Latex';
    run('applyReviewedFields()');
    assert.equal(form.conditions.value, '');
    assert.equal(form.allergies.value.length, form.allergies.maxLength);
    assert.match(get('history-status').textContent, /Shorten.*allergies/);
    assert.equal(get('extraction-review').hidden, false);
});

test('reset uses the same welcome template as the initial screen', () => {
    const {get, run} = setup();
    run('renderWelcome()');
    const initial = get('chat-box').children[0];
    run('resetChat()');
    assert.equal(get('chat-box').children[0], initial);
});
