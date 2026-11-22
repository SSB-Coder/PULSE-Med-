// Optional DOM integration: PULSE_JSDOM_MODULE=/path/to/jsdom node --test tests/dom.integration.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
let JSDOM;
try { ({JSDOM} = require(process.env.PULSE_JSDOM_MODULE || 'jsdom')); } catch {}

test('actual page markup supports multiple medical records and independently restored chats', {skip: !JSDOM}, async () => {
    const dom = new JSDOM(fs.readFileSync('frontend/index.html','utf8'), {url:'https://pulse.example/',runScripts:'outside-only'});
    const w = dom.window;
    const $ = id => w.document.getElementById(id);
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const records = [];
    const chats = new Map();
    let counter = 0;
    w.Headers = Headers;
    w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    w.HTMLDialogElement.prototype.close = function () {
        if (!this.open) return;
        this.open = false;
        w.setTimeout(() => this.dispatchEvent(new w.Event('close')),0);
    };
    w.PULSE_CONFIG = {API_URL:'https://api.example'};
    w.fetch = async (url, options = {}) => {
        const path = new URL(url).pathname;
        const body = options.body ? JSON.parse(options.body) : null;
        let data;
        if (path === '/web/status') data = {available:true};
        else if (path === '/medical-records') {
            if (options.method === 'POST') {
                const record = {id:'record-'+(++counter),...body}; records.unshift(record); data = {record};
            } else data = {records};
        } else if (path.startsWith('/medical-records/')) {
            data = {record: records.find(record => record.id === path.split('/').pop())};
        } else if (path === '/conversations') {
            if (options.method === 'POST') {
                const id = 'chat-'+(++counter);
                const conversation = {...body,id,title:body.messages[0].content.split('.')[0],revision:1};
                chats.set(id,conversation); data = {conversation};
            } else data = {conversations:[...chats.values()],has_more:false};
        } else if (path.startsWith('/conversations/')) {
            const id = path.split('/').pop();
            if (options.method === 'DELETE') {
                chats.delete(id); return {status:204,ok:true};
            }
            if (options.method === 'PUT') chats.set(id,{...body,id,title:body.messages[0].content.split('.')[0],revision:body.revision+1});
            data = {conversation:chats.get(id)};
        } else if (path === '/chat') data = {reply:'Tell me more about the symptoms.'+(body.web_enabled?' [W1]':''),doctors:[],used_history:body.use_history,
            web_status:body.web_enabled?'used':'off',web_notice:body.web_enabled?'Public source read.':'',web_sources:body.web_enabled?[{
                id:'W1',url:'https://www.nhs.uk/topic',title:'Public guidance',publisher:'www.nhs.uk',retrieved_at:'2026-11-22T10:00:00Z',published_at:null,content_hash:'a'.repeat(64),cited:true
            }]:[]};
        else throw new Error('Unexpected endpoint '+url);
        return {status:200,ok:true,json:async()=>structuredClone(data)};
    };
    try {
        // Initialize once after jsdom's native load events, then run the app's entry hook.
        if (w.document.readyState !== 'complete') await new Promise(resolve => w.addEventListener('load',resolve,{once:true}));
        w.eval(fs.readFileSync('frontend/app.js','utf8'));
        w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
        await settle();
        assert.equal($('app-shell').hidden,true);
        $('guest-btn').click();
        assert.equal($('app-shell').hidden,false);
        w.eval("applySession({access_token:'token',user:{id:'user',email:'demo@example.com'}})");
        await settle();
        assert.equal($('history-dialog').open,true);
        for (const [name,notes] of [['General history','Hypertension'],['November report','Migraines']]) {
            $('new-record-btn').click();
            $('record-name').value = name;
            $('history-form').elements.notes.value = notes;
            $('history-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
            await settle();
        }
        assert.equal($('medical-record-list').children.length,2);
        assert.equal(records.length,2);
        assert.equal($('chat-record-select').options.length,3);
        $('history-dialog').close();
        for (const [id,question] of [[records[0].id,'Headache questions'],[records[1].id,'Blood pressure questions']]) {
            $('chat-record-select').value = id;
            $('chat-record-select').dispatchEvent(new w.Event('change'));
            $('use-history').checked = true;
            $('use-history').dispatchEvent(new w.Event('change'));
            if (question === 'Headache questions') {
                $('use-web').checked=true; $('use-web').dispatchEvent(new w.Event('change'));
                $('web-query').value='migraine guidance'; $('web-query').dispatchEvent(new w.Event('input'));
                $('web-consent').checked=true;
            }
            $('user-input').value = question;
            await w.eval('sendbtn()');
            assert.equal($('conversation-list').children.length,chats.size);
            await w.eval('newChat()');
        }
        assert.equal(chats.size,2);
        const first = [...chats.values()][0];
        const button = [...$('conversation-list').querySelectorAll('.conversation-open')].find(button => button.textContent === first.title);
        button.click(); await settle();
        assert.equal($('chat-record-select').value,first.medical_record_id);
        assert.equal($('use-history').checked,true);
        assert.equal($('chat-box').querySelectorAll('.message').length,2);
        assert.equal($('active-chat-title').textContent,first.title);
        assert.equal($('use-web').checked,true);
        assert.equal($('web-query').value,'');
        assert.equal($('web-consent').checked,false);
        assert.equal($('chat-box').querySelectorAll('.web-source a').length,1);
        const active = $('conversation-list').querySelector('[aria-current="true"]');
        active.parentElement.querySelector('.conversation-delete').click();
        assert.equal($('delete-chat-dialog').open,true);
        $('confirm-delete-chat').click(); await settle();
        assert.equal(chats.size,1);
        assert.equal(records.length,2);
        w.eval('applySession(null)');
        assert.equal($('conversation-list').children.length,0);
        assert.equal($('medical-record-list').querySelectorAll('button').length,0);
        assert.equal($('history-form').elements.notes.value,'');
    } finally { w.close(); }
});
