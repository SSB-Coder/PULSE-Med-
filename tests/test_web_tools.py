"""No live search key, cloud writes, or external page requests."""
import json
from contextlib import contextmanager
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

import main
import services
import web_agent
import web_tools as web
from web_policy import approved_query, approved_url
from tests.test_app import HEADERS, USER_A, client, fake_completion


@pytest.mark.parametrize('url', [
    'http://nhs.uk/a', 'https://nhs.uk.evil.test/', 'https://evilnhs.uk/', 'https://nhs.uk@127.0.0.1/',
    'https://nhs.uk:444/', 'https://127.0.0.1/', 'https://[::1]/', 'file:///etc/passwd',
    'https://nhs.uk\\@evil.test/', 'https://nhs.uk/\nsecret', 'https://nhs.uk./',
])
def test_url_policy_rejects_bypasses(url):
    with pytest.raises(ValueError): approved_url(url)


def test_url_policy_preserves_approved_subdomains_and_strips_fragment():
    assert approved_url('https://WWW.NHS.UK/symptoms/headaches/#urgent') == 'https://www.nhs.uk/symptoms/headaches/'
    assert approved_url('https://www.cdc.gov:443/health') == 'https://www.cdc.gov/health'


@pytest.mark.parametrize('query', ['my migraine', 'John@example.com headache', 'DOB 1990-01-01',
                                  'nhs.uk symptoms', 'patient 12345', 'i have pain', 'site:evil.com migraine', 'x'*181])
def test_public_query_rejects_personal_narratives_identifiers_and_operators(query):
    with pytest.raises(ValueError): approved_query(query)


def test_query_allows_generic_topics_and_normalizes_only_approved_terms():
    assert approved_query('  type 2 diabetes   guidance ') == 'type 2 diabetes guidance'


@pytest.mark.parametrize('address', ['127.0.0.1','10.1.2.3','169.254.169.254','::1','fc00::1','224.0.0.1','fec0::1','::ffff:8.8.8.8'])
def test_dns_rejects_private_reserved_multicast_and_mapped_addresses(monkeypatch, address):
    resolver = Mock()
    resolver.resolve.side_effect = lambda host, family, **kw: [address] if family == 'A' else []
    monkeypatch.setattr(web.dns.resolver,'Resolver',lambda:resolver)
    with pytest.raises(web.ToolError): web.public_addresses('www.nhs.uk',3)


def test_mixed_public_private_dns_fails_closed(monkeypatch):
    resolver = Mock()
    resolver.resolve.side_effect = lambda host, family, **kw: ['8.8.8.8','10.0.0.1'] if family == 'A' else []
    monkeypatch.setattr(web.dns.resolver,'Resolver',lambda:resolver)
    with pytest.raises(web.ToolError): web.public_addresses('www.nhs.uk',3)


def test_connection_is_pinned_with_original_tls_host_no_proxy_and_no_credentials(monkeypatch):
    monkeypatch.setattr(web,'public_addresses',lambda host,remaining:['8.8.8.8'])
    calls=[]
    response=httpx.Response(200,headers={'content-type':'text/plain'},stream=httpx.ByteStream(b'public text'))
    class TransportClient:
        def __init__(self,**kwargs):
            assert kwargs['trust_env'] is False and kwargs['follow_redirects'] is False
        def __enter__(self):return self
        def __exit__(self,*args):pass
        @contextmanager
        def stream(self,method,url,**kwargs):
            calls.append((method,url,kwargs));yield response
    monkeypatch.setattr(web.httpx,'Client',TransportClient)
    status,headers,body,url=web.safe_get('https://www.nhs.uk/example',time.monotonic()+10)
    assert status==200 and body==b'public text'
    method,pinned,options=calls[0]
    assert pinned.host=='8.8.8.8' and pinned.path=='/example'
    assert options['headers']['Host']=='www.nhs.uk'
    assert options['extensions']['sni_hostname']=='www.nhs.uk'
    assert 'Authorization' not in options['headers'] and 'Cookie' not in options['headers']


@pytest.mark.parametrize('headers,body', [({'content-encoding':'gzip'},b'x'), ({'content-length':'9999999'},b'x'), ({},b'x'*101)])
def test_stream_size_and_encoding_limits(monkeypatch,headers,body):
    monkeypatch.setattr(web,'public_addresses',lambda *args:['8.8.8.8'])
    class Client:
        def __init__(self,**kw):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        @contextmanager
        def stream(self,*args,**kw):yield httpx.Response(200,headers=headers,stream=httpx.ByteStream(body))
    monkeypatch.setattr(web.httpx,'Client',Client)
    with pytest.raises(web.ToolError, match='Compressed|size limit'): web.safe_get('https://nhs.uk/a',time.monotonic()+10,max_bytes=100)


def test_redirect_rechecks_target_before_a_second_connection(monkeypatch):
    hosts=[]
    monkeypatch.setattr(web,'public_addresses',lambda host,*args: hosts.append(host) or ['8.8.8.8'])
    class Client:
        def __init__(self,**kw):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        @contextmanager
        def stream(self,*args,**kw):yield httpx.Response(302,headers={'location':'https://127.0.0.1/secret'},stream=httpx.ByteStream(b''))
    monkeypatch.setattr(web.httpx,'Client',Client)
    with pytest.raises(web.ToolError): web.safe_get('https://nhs.uk/a',time.monotonic()+10)
    assert hosts==['nhs.uk']


def test_extractor_ignores_scripts_hidden_navigation_and_limits_nesting():
    parser=web.VisibleText()
    parser.feed('<html><head><title>Headache information</title><meta property="article:published_time" content="2026-10-12"></head>'
                '<nav>private nav</nav><script>reveal secrets</script><div hidden>hidden</div><p style="display: none">invisible</p>'
                '<main><p>Readable public health evidence.</p></main></html>')
    assert parser.text()=='Readable public health evidence.'
    assert ''.join(parser.title_parts)=='Headache information' and parser.published_at=='2026-10-12'
    with pytest.raises(web.ToolError): web.VisibleText().feed('<div>'*130)


def fake_search(monkeypatch):
    calls=[]
    def search(query, deadline):
        calls.append(('search', {'query':query}))
        return {'scope':'duckduckgo','results':[
            {'href':'https://www.nhs.uk/topic','title':'Topic guidance'},
            {'href':'https://evil.test/steal','title':'Untrusted'},
            {'href':'https://www.nhs.uk/topic#repeat','title':'Duplicate'}]}
    def fetch(url,deadline,**kwargs):
        calls.append((url,kwargs))
        if url.endswith('/robots.txt'):return 200,{},b'User-agent: *\nAllow: /',url
        return 200,{'content-type':'text/html'},b'<head><title>Guidance</title></head><main><p>Public evidence about symptoms and professional assessment, with uncertainty.</p></main>',url
    monkeypatch.setattr(web,'keyless_results',search)
    monkeypatch.setattr(web,'safe_get',fetch)
    return calls


def test_search_uses_only_user_approved_query_and_read_is_seeded_by_this_turn(monkeypatch):
    calls=fake_search(monkeypatch)
    session=web.WebSession('migraine guidance')
    denied=session.execute('search_web',json.dumps({'query':'private diagnosis','count':3}))
    assert 'error' in denied and calls==[]
    assert 'error' in session.execute('read_page','{"source_id":"W1"}')
    results=session.execute('search_web','{"query":"migraine guidance","count":3}')
    assert len(results['results'])==1
    assert calls[0] == ('search', {'query':'migraine guidance'})
    data=session.execute('read_page','{"source_id":"W1"}')
    assert data['source']['url']=='https://www.nhs.uk/topic'
    assert data['source']['content_hash'] and 'Public evidence' in data['text']
    assert 'error' in session.execute('search_web','{"query":"migraine guidance"}')
    assert session.calls==5  # Denied calls also consume the turn budget.


def test_robot_denial_and_unsupported_page_types_are_not_read(monkeypatch):
    session=web.WebSession('migraine guidance')
    session.results={'W1':{'id':'W1','url':'https://www.nhs.uk/topic','title':'Topic','publisher':'www.nhs.uk'}}
    requests=[]
    def fetch(url,*args,**kw):
        requests.append(url)
        return 200,{},b'User-agent: *\nDisallow: /',url
    monkeypatch.setattr(web,'safe_get',fetch)
    assert 'error' in session.execute('read_page','{"source_id":"W1"}')
    assert requests==['https://www.nhs.uk/robots.txt']


def test_unknown_tools_invalid_json_and_expired_budget_do_not_fetch(monkeypatch):
    fetch=Mock(side_effect=AssertionError('No network'))
    monkeypatch.setattr(web,'safe_get',fetch)
    session=web.WebSession('migraine guidance')
    for name,args in [('send_email','{}'),('search_web','not JSON'),('search_web','{"query":"migraine guidance","count":true}')]:
        assert 'error' in session.execute(name,args)
    session.deadline=time.monotonic()-1
    assert 'error' in session.execute('search_web','{"query":"migraine guidance"}')
    fetch.assert_not_called()


def completion(content=None,calls=None):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content,tool_calls=calls))])

def call(name,args,id):
    return SimpleNamespace(id=id,function=SimpleNamespace(name=name,arguments=json.dumps(args)))


def test_tool_loop_returns_only_fetched_sources_and_rejects_fabricated_citations(monkeypatch):
    fake_search(monkeypatch)
    groq=Mock()
    groq.with_options.return_value=groq
    groq.chat.completions.create.side_effect=[
        completion(calls=[call('search_web',{'query':'migraine guidance'},'s')]),
        completion(calls=[call('read_page',{'source_id':'W1'},'r')]),
        completion('Possible causes need clinical assessment [W1]. Unsupported [W99]. https://evil.test/'),
    ]
    result=web_agent.run(groq,{'model':'test'},[{'role':'system','content':'Rules'}],'migraine guidance')
    assert len(result['web_sources'])==1 and result['web_sources'][0]['cited']
    assert '[W1]' in result['reply'] and '[W99]' not in result['reply']
    assert 'https://evil.test/' not in result['reply']
    assert result['web_status']=='limited'
    assert groq.chat.completions.create.call_count==3
    final=groq.chat.completions.create.call_args.kwargs
    assert final['tool_choice']=='none'
    assert [m['tool_call_id'] for m in final['messages'] if m['role']=='tool']==['s','r']


def test_searched_titles_are_not_treated_as_fetched_evidence(monkeypatch):
    fake_search(monkeypatch)
    groq=Mock();groq.with_options.return_value=groq
    groq.chat.completions.create.side_effect=[completion(calls=[call('search_web',{'query':'migraine guidance'},'s')]),completion('A claim [W1]')]
    result=web_agent.run(groq,{'model':'test'},[{'role':'system','content':'Rules'}],'migraine guidance')
    assert result['web_sources']==[] and '[W1]' not in result['reply']
    assert result['web_status']=='no_results'


def test_web_off_exposes_no_tools_and_does_not_claim_budget(client,monkeypatch):
    monkeypatch.setenv('WEB_TOOLS_ENABLED','true')
    store=Mock();store.similarity_search.return_value=[]
    monkeypatch.setattr(services,'get_vector_store',lambda:store)
    groq=Mock();groq.chat.completions.create.return_value=fake_completion('Ordinary answer')
    monkeypatch.setattr(services,'get_groq',lambda:groq)
    request=Mock(side_effect=AssertionError('No budget RPC or search'))
    monkeypatch.setattr(services,'supabase_request',request)
    result=client.post('/chat',json={'messages':[{'role':'user','content':'What is migraine?'}]})
    assert result.status_code==200 and result.json()['web_status']=='off'
    assert 'tools' not in groq.chat.completions.create.call_args.kwargs
    request.assert_not_called()


def test_web_requires_account_query_approval_and_rejects_raw_narratives(client):
    body={'messages':[{'role':'user','content':'headache'}],'web_enabled':True,'web_query':'migraine guidance','web_query_consent':True}
    assert client.post('/chat',json=body).status_code==401
    assert client.post('/chat',headers=HEADERS,json={**body,'web_query_consent':False}).status_code==422
    assert client.post('/chat',headers=HEADERS,json={**body,'web_query':'my name John headache'}).status_code==422


def test_web_failure_and_rate_limit_leave_ordinary_chat_working(client,monkeypatch):
    monkeypatch.setenv('WEB_TOOLS_ENABLED','true')
    store=Mock();store.similarity_search.return_value=[]
    monkeypatch.setattr(services,'get_vector_store',lambda:store)
    groq=Mock();groq.chat.completions.create.return_value=fake_completion('Cautious fallback')
    monkeypatch.setattr(services,'get_groq',lambda:groq)
    request=Mock(return_value=False);monkeypatch.setattr(services,'supabase_request',request)
    body={'messages':[{'role':'user','content':'headache'}],'web_enabled':True,'web_query':'migraine guidance','web_query_consent':True}
    result=client.post('/chat',headers=HEADERS,json=body)
    assert result.status_code==200 and result.json()['web_status']=='rate_limited'
    assert result.json()['web_sources']==[]
    request.assert_called_once_with('POST','/rest/v1/rpc/claim_pulse_web_budget','user-a-token',json={})
    request.return_value=True
    monkeypatch.setattr(web_agent,'run',Mock(side_effect=RuntimeError('provider leaked private body')))
    result=client.post('/chat',headers=HEADERS,json=body)
    assert result.status_code==200 and result.json()['web_status']=='error'
    assert 'private body' not in result.text


def test_missing_index_can_use_opted_in_web_without_false_reference_claim(client,monkeypatch):
    monkeypatch.setenv('WEB_TOOLS_ENABLED','true')
    monkeypatch.setattr(services,'get_vector_store',Mock(side_effect=RuntimeError('offline')))
    monkeypatch.setattr(services,'supabase_request',Mock(return_value=True))
    monkeypatch.setattr(services,'get_groq',lambda:Mock())
    agent=Mock(return_value={'reply':'Evidence-linked reply','web_sources':[],'web_status':'not_used','web_notice':'No web used.'})
    monkeypatch.setattr(web_agent,'run',agent)
    body={'messages':[{'role':'user','content':'headache'}],'web_enabled':True,'web_query':'migraine guidance','web_query_consent':True}
    result=client.post('/chat',headers=HEADERS,json=body)
    assert result.status_code==200 and 'also unavailable' in result.json()['web_notice']
    assert 'Reference retrieval is unavailable' in agent.call_args.args[2][0]['content']


@pytest.mark.parametrize('message',["I cannot breathe",'I have a sudden severe headache','Chest pain and difficulty breathing'])
def test_red_flag_does_not_wait_for_search_or_model(client,monkeypatch,message):
    model=Mock(side_effect=AssertionError('No model delay'));search=Mock(side_effect=AssertionError('No search delay'))
    monkeypatch.setattr(services,'get_groq',model);monkeypatch.setattr(web_agent,'run',search)
    result=client.post('/chat',json={'messages':[{'role':'user','content':message}],'web_enabled':True})
    assert result.status_code==200 and 'emergency' in result.json()['reply']
    assert result.json()['doctors']==[] and result.json()['web_sources']==[]
    model.assert_not_called();search.assert_not_called()


def test_page_redirects_recheck_robots_before_fetching_destination(monkeypatch):
    calls=[]
    session=web.WebSession('migraine guidance')
    session.results={'W1':{'id':'W1','url':'https://www.nhs.uk/old','title':'Topic','publisher':'www.nhs.uk'}}
    def fetch(url,*args,**kwargs):
        calls.append(url)
        if url.endswith('/robots.txt'):
            return 200,{},b'User-agent: *\nDisallow: /blocked',url
        if url.endswith('/old'):
            return 302,{'location':'/blocked'},b'',url
        raise AssertionError('Blocked destination must not be requested')
    monkeypatch.setattr(web,'safe_get',fetch)
    assert 'error' in session.execute('read_page','{"source_id":"W1"}')
    assert calls==['https://www.nhs.uk/robots.txt','https://www.nhs.uk/old']


@pytest.mark.parametrize('robots', [b'User-agent: *\nCrawl-delay: 10',b'User-agent: *\nRequest-rate: 1/10'])
def test_crawl_schedule_constraints_fail_closed(monkeypatch,robots):
    monkeypatch.setattr(web,'safe_get',lambda url,*args,**kw:(200,{},robots,url))
    with pytest.raises(web.ToolError,match='crawl schedule'):
        web.WebSession('migraine guidance').robots_allowed('https://www.nhs.uk/topic')


@pytest.mark.parametrize('kind,body,extra',[
    ('application/pdf',b'%PDF',{}),
    ('text/html',b'<meta name="robots" content="noai"><p>'+b'evidence '*20+b'</p>',{}),
    ('text/plain',b'evidence '*20,{'x-robots-tag':'noai'}),
])
def test_content_policy_and_noai_directives_do_not_reach_model(monkeypatch,kind,body,extra):
    session=web.WebSession('migraine guidance')
    session.results={'W1':{'id':'W1','url':'https://www.nhs.uk/topic','title':'Topic','publisher':'www.nhs.uk'}}
    monkeypatch.setattr(session,'robots_allowed',lambda _:True)
    monkeypatch.setattr(web,'safe_get',lambda url,*a,**kw:(200,{'content-type':kind,**extra},body,url))
    assert 'error' in session.execute('read_page','{"source_id":"W1"}')
    assert session.sources=={}


def test_tool_round_and_context_limits_are_enforced(monkeypatch):
    groq=Mock();groq.with_options.return_value=groq
    groq.chat.completions.create.return_value=completion(calls=[call('unknown',{},'x')])
    with pytest.raises(web.ToolError,match='tool rounds'):
        web_agent.run(groq,{'model':'test'},[{'role':'system','content':'Rules'}],'migraine guidance')
    assert groq.chat.completions.create.call_count==3
    groq.chat.completions.create.reset_mock()
    with pytest.raises(web.ToolError,match='context budget'):
        web_agent.run(groq,{'model':'test'},[{'role':'system','content':'x'*100001}],'migraine guidance')
    groq.chat.completions.create.assert_not_called()


def test_no_evidence_is_fabricated_when_provider_is_disabled_or_busy(client,monkeypatch):
    store=Mock();store.similarity_search.return_value=[]
    monkeypatch.setattr(services,'get_vector_store',lambda:store)
    groq=Mock();groq.chat.completions.create.return_value=fake_completion('Ordinary fallback')
    monkeypatch.setattr(services,'get_groq',lambda:groq)
    monkeypatch.setenv('WEB_TOOLS_ENABLED','false')
    body={'messages':[{'role':'user','content':'headache'}],'web_enabled':True,'web_query':'migraine guidance','web_query_consent':True}
    response=client.post('/chat',headers=HEADERS,json=body)
    assert response.json()['web_status']=='unavailable' and response.json()['web_sources']==[]
    monkeypatch.setenv('WEB_TOOLS_ENABLED','true')
    slots=Mock();slots.acquire.return_value=False
    monkeypatch.setattr(web,'WEB_SLOTS',slots)
    response=client.post('/chat',headers=HEADERS,json=body)
    assert response.json()['web_status']=='busy'
    slots.release.assert_not_called()


def test_citations_serialize_into_saved_messages_and_unsafe_links_are_rejected(client,monkeypatch):
    source={'id':'W1','url':'https://www.nhs.uk/topic','title':'Guidance','publisher':'www.nhs.uk',
            'retrieved_at':'2026-11-22T10:00:00Z','published_at':'2026-01-01','content_hash':'a'*64,'cited':True}
    write=Mock(return_value=[{'id':'chat','revision':1}])
    monkeypatch.setattr(services,'supabase_request',write)
    payload={'web_enabled':True,'messages':[{'role':'user','content':'Headache'},
        {'role':'assistant','content':'Possible causes [W1]','web_sources':[source],'web_status':'used','web_notice':'Page read.'}]}
    assert client.post('/conversations',headers=HEADERS,json=payload).status_code==201
    saved=write.call_args.kwargs['json']
    assert saved['web_enabled'] is True
    assert isinstance(saved['messages'][1]['web_sources'][0]['retrieved_at'],str)
    payload['messages'][1]['web_sources'][0]['url']='javascript:alert(1)'
    assert client.post('/conversations',headers=HEADERS,json=payload).status_code==422


def test_old_citation_markers_are_not_reused_as_new_web_evidence(client,monkeypatch):
    store=Mock();store.similarity_search.return_value=[]
    monkeypatch.setattr(services,'get_vector_store',lambda:store)
    groq=Mock();groq.chat.completions.create.return_value=fake_completion('Answer')
    monkeypatch.setattr(services,'get_groq',lambda:groq)
    response=client.post('/chat',json={'messages':[{'role':'assistant','content':'Earlier evidence [W1]'},
                                               {'role':'user','content':'Explain more'}]})
    assert response.status_code==200
    assert '[W1]' not in groq.chat.completions.create.call_args.kwargs['messages'][1]['content']


def test_prompt_context_cap_stops_provider_calls_and_urgency_screen_is_not_a_safety_verdict(client,monkeypatch):
    from clinical_safety import possible_emergency
    assert not possible_emergency('I am not struggling to breathe. I have a mild cough.')
    assert not possible_emergency('I have a headache')
    store=Mock();store.similarity_search.return_value=[]
    monkeypatch.setattr(services,'get_vector_store',lambda:store)
    groq=Mock();monkeypatch.setattr(services,'get_groq',lambda:groq)
    body={'messages':[{'role':'user','content':'x'*8000} for _ in range(10)]}
    assert client.post('/chat',json=body).status_code==413
    groq.chat.completions.create.assert_not_called()


def test_web_reply_cannot_link_to_unverified_html_relative_or_uppercase_urls():
    session=web.WebSession('migraine guidance')
    result=web_agent.finalize('<a href="//evil.test">click</a> [label](//evil.test) HTTPS://EVIL.TEST www.evil.test\n[ref]: https://evil.test',session)
    assert '<a' not in result['reply']
    assert '//evil.test' not in result['reply'].lower()
    assert 'www.evil.test' not in result['reply']


def test_keyless_availability_requires_flag_but_no_search_api_key(client,monkeypatch):
    monkeypatch.delenv('BRAVE_SEARCH_API_KEY',raising=False)
    monkeypatch.setenv('WEB_TOOLS_ENABLED','true')
    assert web.available() is True
    response=client.get('/web/status')
    assert response.status_code==200 and response.json()['available'] is True
    assert 'BRAVE' not in response.text and response.headers['cache-control']=='no-store'
    monkeypatch.setenv('WEB_TOOLS_ENABLED','false')
    assert web.available() is False


def test_ddgs_parser_uses_only_the_bounded_transport_not_library_http(monkeypatch):
    import ddgs.http_client
    native=Mock(side_effect=AssertionError('Native library HTTP must not be used'))
    monkeypatch.setattr(ddgs.http_client.HttpClient,'request',native)
    requests=[]
    def fetch(url,deadline,**kwargs):
        requests.append((url,kwargs))
        return 200,{'content-type':'text/html'},b'''<html><div class="result__body"><h2>Headache guidance</h2>
            <a href="https://www.nhs.uk/symptoms/headaches/">Snippet</a></div></html>''',url
    monkeypatch.setattr(web,'safe_get',fetch)
    rows=web.duckduckgo_results('migraine',time.monotonic()+10)
    assert rows[0]['href']=='https://www.nhs.uk/symptoms/headaches/'
    assert 'migraine' in requests[0][0] and 'site%3Anhs.uk' in requests[0][0]
    assert requests[0][1]['domains']==('html.duckduckgo.com',)
    assert requests[0][1]['redirects']==0 and requests[0][1]['max_bytes']==256000
    assert 'X-Subscription-Token' not in requests[0][1].get('headers',{})
    native.assert_not_called()


@pytest.mark.parametrize('value',[
    '/l/?uddg=https%3A%2F%2Fwww.nhs.uk%2Ftopic',
    '//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.nhs.uk%2Ftopic',
    'https://html.duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.nhs.uk%2Ftopic',
])
def test_keyless_redirect_wrapper_is_decoded_without_network(value):
    assert web.unwrap_search_result(value)=='https://www.nhs.uk/topic'


@pytest.mark.parametrize('value',[
    'https://evil.test/l/?uddg=https%3A%2F%2Fwww.nhs.uk%2Ftopic',
    '/l/?uddg=https%3A%2F%2F127.0.0.1%2F',
    '/l/?uddg=https%3A%2F%2Fwww.nhs.uk%2F&uddg=https%3A%2F%2Fevil.test%2F',
])
def test_keyless_wrapper_cannot_bypass_source_allowlist(value):
    with pytest.raises(ValueError): web.unwrap_search_result(value)


def test_medlineplus_fallback_is_honest_and_does_not_change_approved_query(monkeypatch):
    duck=Mock(side_effect=web.ToolError('Blocked'))
    medical=Mock(return_value=[{'href':'https://medlineplus.gov/migraine.html','title':'Migraine'}])
    monkeypatch.setattr(web,'duckduckgo_results',duck)
    monkeypatch.setattr(web,'medlineplus_results',medical)
    result=web.WebSession('migraine').execute('search_web','{"query":"migraine","count":3}')
    assert result['scope']=='medlineplus'
    assert result['results'][0]['url']=='https://medlineplus.gov/migraine.html'
    assert duck.call_args.args[0]==medical.call_args.args[0]=='migraine'
    session=web.WebSession('migraine'); session.discovery_scope='medlineplus'
    final=web_agent.finalize('No fresh page evidence yet.',session)
    assert 'MedlinePlus.gov health topics' in final['web_notice']
    assert 'broader web search was unavailable' in final['web_notice']


def test_successful_general_search_does_not_contact_fallback(monkeypatch):
    monkeypatch.setattr(web,'duckduckgo_results',lambda *args:[{'href':'https://www.nhs.uk/topic','title':'Topic'}])
    fallback=Mock(side_effect=AssertionError('No unnecessary fallback'))
    monkeypatch.setattr(web,'medlineplus_results',fallback)
    assert web.keyless_results('migraine',time.monotonic()+10)['scope']=='duckduckgo'
    fallback.assert_not_called()


def test_medlineplus_xml_title_and_url_only_no_summary_or_external_entity(monkeypatch):
    requests=[]
    body=b'''<nlmSearchResult><list><document url="https://medlineplus.gov/migraine.html">
        <content name="title">Migraine</content><content name="FullSummary">Do not copy this snippet as evidence</content>
        </document></list></nlmSearchResult>'''
    def fetch(url,deadline,**kwargs):requests.append((url,kwargs));return 200,{'content-type':'text/xml; charset=UTF-8'},body,url
    monkeypatch.setattr(web,'safe_get',fetch)
    assert web.medlineplus_results('migraine',time.monotonic()+10)==[{'href':'https://medlineplus.gov/migraine.html','title':'Migraine'}]
    assert 'term=migraine' in requests[0][0] and 'tool=pulsemed' in requests[0][0]
    assert requests[0][1]['domains']==('wsearch.nlm.nih.gov',)
    body=b'''<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><nlmSearchResult>&xxe;</nlmSearchResult>'''
    with pytest.raises(web.ToolError,match='unusable response'):
        web.medlineplus_results('migraine',time.monotonic()+10)


def test_keyless_search_timeout_does_not_continue_in_background_or_retry(monkeypatch):
    monkeypatch.setattr(web,'duckduckgo_results',Mock(side_effect=web.ToolError('Timed out')))
    fallback=Mock(side_effect=AssertionError('No time remains'))
    monkeypatch.setattr(web,'medlineplus_results',fallback)
    with pytest.raises(web.ToolError,match='time budget'):
        web.keyless_results('migraine',time.monotonic()-1)
    fallback.assert_not_called()
