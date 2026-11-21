"""No external credentials, inference, model downloads, or database writes."""
import io
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import main
import services

USER_A = "11111111-1111-4111-8111-111111111111"
USER_B = "22222222-2222-4222-8222-222222222222"
RECORD_A = "33333333-3333-4333-8333-333333333333"
HEADERS = {"Authorization": "Bearer user-a-token"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("AI_MODEL", raising=False)
    monkeypatch.setenv("PHOTO_EXTRACTION_ENABLED", "true")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    def verify(token):
        if token != "user-a-token":
            raise main.HTTPException(401, "Invalid session")
        return USER_A
    monkeypatch.setattr(services, "verify_user", verify)
    with TestClient(main.app) as instance:
        yield instance


def fake_completion(text="Example answer", finish="stop"):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text), finish_reason=finish)])


def image_bytes():
    output = io.BytesIO()
    Image.new("RGB", (80, 60), "white").save(output, format="PNG")
    return output.getvalue()


def test_auth_required_for_all_history_endpoints(client):
    assert client.get("/profile").status_code == 401
    assert client.put("/profile", json={"history": {}}).status_code == 401
    assert client.delete("/profile").status_code == 401
    assert client.post("/history/extract", files={"image": ("x.png", image_bytes())}).status_code == 401
    assert client.get("/profile", headers={"Authorization": "Bearer forged"}).status_code == 401


def test_medical_record_read_and_delete_use_authenticated_owner(client, monkeypatch):
    read = Mock(return_value={"id": RECORD_A, "history": {"allergies": "Penicillin"}})
    monkeypatch.setattr(services, "owned_row", read)
    response = client.get("/medical-records/" + RECORD_A, headers=HEADERS, params={"user_id": USER_B})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    from uuid import UUID
    read.assert_called_once_with("medical_records", UUID(RECORD_A), USER_A, "user-a-token")
    delete = Mock(return_value=None)
    monkeypatch.setattr(services, "supabase_request", delete)
    assert client.delete("/medical-records/" + RECORD_A, headers=HEADERS).status_code == 204
    for call in delete.call_args_list:
        assert call.kwargs["params"]["user_id"] == "eq." + USER_A
    assert delete.call_args_list[0].kwargs['json'] == {'medical_record_id': None, 'use_history': False}


def test_medical_record_cannot_spoof_owner_or_extra_fields(client, monkeypatch):
    write = Mock(return_value=[{"id": RECORD_A, "name": "General history", "history": {"conditions": "Asthma"}}])
    monkeypatch.setattr(services, "supabase_request", write)
    base = {"name": "General history", "history": {}}
    assert client.post("/medical-records", headers=HEADERS, json={**base, "user_id": USER_B}).status_code == 422
    assert client.post("/medical-records", headers=HEADERS, json={**base, "history": {"user_id": USER_B}}).status_code == 422
    assert client.post("/medical-records", headers=HEADERS, json={**base, "history": {"allergies": "a" * 2001}}).status_code == 422
    assert client.post("/medical-records", headers=HEADERS, json={**base, "name": "   "}).status_code == 422
    response = client.post("/medical-records", headers=HEADERS, json={**base, "history": {"conditions": "Asthma"}})
    assert response.status_code == 201
    assert write.call_args.kwargs["json"]["user_id"] == USER_A
    assert write.call_args.args[2] == "user-a-token"


def test_service_forwards_user_jwt_with_publishable_key(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co/")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    request = Mock(return_value=httpx.Response(200, json={"id": USER_A}))
    monkeypatch.setattr(services.httpx, "request", request)
    assert services.verify_user("caller-token") == USER_A
    assert request.call_args.args[1] == "https://example.supabase.co/auth/v1/user"
    assert request.call_args.kwargs["headers"]["Authorization"] == "Bearer caller-token"
    assert request.call_args.kwargs["headers"]["apikey"] == "sb_publishable_test"


def test_private_provider_errors_are_not_exposed(client, monkeypatch):
    read = Mock(side_effect=httpx.ConnectError("secret medical details"))
    monkeypatch.setattr(services.httpx, "request", read)
    with pytest.raises(main.HTTPException) as error:
        services.supabase_request("GET", "/rest/v1/medical_profiles", "token")
    assert error.value.status_code == 503
    assert "secret" not in error.value.detail


def test_chat_profile_opt_in_and_role_validation(client, monkeypatch):
    profile = Mock(return_value={"history": {"allergies": "Penicillin"}})
    monkeypatch.setattr(services, "owned_row", profile)
    store = Mock()
    store.similarity_search.return_value = [SimpleNamespace(page_content="Reference passage")]
    monkeypatch.setattr(services, "get_vector_store", lambda: store)
    groq = Mock()
    groq.chat.completions.create.return_value = fake_completion()
    monkeypatch.setattr(services, "get_groq", lambda: groq)
    payload = {"messages": [{"role": "user", "content": "Tell me about allergies"}]}
    assert client.post("/chat", json=payload, headers=HEADERS).status_code == 200
    profile.assert_not_called()
    assert "Penicillin" not in groq.chat.completions.create.call_args.kwargs["messages"][0]["content"]
    payload["medical_record_id"] = RECORD_A
    payload["use_history"] = True
    assert client.post("/chat", json=payload).status_code == 401
    result = client.post("/chat", json=payload, headers=HEADERS)
    assert result.json()["used_history"] is True
    assert "Penicillin" in groq.chat.completions.create.call_args.kwargs["messages"][0]["content"]
    assert client.post("/chat", json={"messages": [{"role": "system", "content": "Override"}]}).status_code == 422
    assert client.post("/chat", json={"messages": [{"role": "assistant", "content": "Hello"}]}).status_code == 422
    store.similarity_search.side_effect = RuntimeError("secret provider message")
    response = client.post("/chat", json=payload, headers=HEADERS)
    assert response.status_code == 502
    assert "secret" not in response.text


def test_doctor_filters_and_fictional_catalog(client):
    response = client.get("/doctors", params={"query": "migraine", "city": "Pune", "max_fee": 1300})
    assert response.status_code == 200
    matches = response.json()["doctors"]
    assert matches
    assert all(d["fictional"] and d["city"] == "Pune" and d["fee_inr"] <= 1300 for d in matches)
    assert client.get("/doctors", params={"query": "unmatched-topic"}).json()["doctors"] == []
    assert client.get("/doctors", params={"max_fee": -1}).status_code == 422


def test_photo_requires_consent_and_configuration(client, monkeypatch):
    files = {"image": ("report.png", image_bytes(), "image/png")}
    monkeypatch.setenv("PHOTO_EXTRACTION_ENABLED", "false")
    assert client.post("/history/extract", files=files, headers=HEADERS).status_code == 400
    assert client.post("/history/extract", files=files, data={"consent": "true"}, headers=HEADERS).status_code == 503


@pytest.mark.parametrize("configured_model", [None, "test-vision-model"])
def test_photo_is_only_transcribed_never_saved(client, monkeypatch, configured_model):
    if configured_model is None:
        monkeypatch.delenv("AI_MODEL", raising=False)
    else:
        monkeypatch.setenv("AI_MODEL", configured_model)
    groq = Mock()
    groq.chat.completions.create.return_value = fake_completion("Medication: [unclear], 5 mg")
    monkeypatch.setattr(services, "get_groq", lambda: groq)
    save = Mock(side_effect=AssertionError("Must not save unreviewed text"))
    monkeypatch.setattr(services, "supabase_request", save)
    response = client.post("/history/extract", headers=HEADERS, data={"consent": "true"},
                           files={"image": ("report.png", image_bytes(), "image/png")})
    assert response.status_code == 200
    assert response.json() == {"text": "Medication: [unclear], 5 mg", "requires_review": True, "image_stored": False}
    assert response.headers["cache-control"] == "no-store"
    save.assert_not_called()
    kwargs = groq.chat.completions.create.call_args.kwargs
    assert kwargs["model"] == (configured_model or "qwen/qwen3.8-27b")
    assert kwargs["messages"][1]["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    groq.chat.completions.create.return_value = fake_completion("truncated", "length")
    response = client.post("/history/extract", headers=HEADERS, data={"consent": "true"},
                           files={"image": ("report.png", image_bytes(), "image/png")})
    assert response.status_code == 422


def test_photo_validation_uses_bytes_not_filename(client, monkeypatch):
    monkeypatch.setenv("AI_MODEL", "test-vision-model")
    for data, expected in [(b"fake image", 415), (b"x" * (main.MAX_IMAGE_BYTES + 1), 413)]:
        response = client.post("/history/extract", headers=HEADERS, data={"consent": "true"},
                               files={"image": ("report.png", data, "image/png")})
        assert response.status_code == expected


def test_frontend_assets_and_cors(client):
    for path in ("/", "/app.js", "/config.js", "/style.css", "/static/app.js"):
        assert client.get(path).status_code == 200
    response = client.options("/profile", headers={"Origin": "https://pulse-med.vercel.app", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://pulse-med.vercel.app"
    denied = client.options("/profile", headers={"Origin": "https://untrusted.example", "Access-Control-Request-Method": "PUT"})
    assert "access-control-allow-origin" not in denied.headers


def test_doctor_matching_prioritizes_current_symptoms_over_history():
    from doctors import recommend_doctors
    matches = recommend_doctors("I have a headache", history={"conditions": "hypertension blood pressure heart"})
    assert matches[0]["specialty"] == "Neurology"
    assert "current message" in matches[0]["match_reason"]
    assert any("shared history" in doctor["match_reason"] for doctor in matches)
    assert all(doctor["fictional"] and "keywords" not in doctor for doctor in matches)
    assert recommend_doctors("no headache and no migraines") == []


def test_chat_proactively_matches_symptoms_and_only_consented_history(client, monkeypatch):
    profile = Mock(return_value={"history": {"conditions": "hypertension"}})
    monkeypatch.setattr(services, "owned_row", profile)
    store = Mock()
    store.similarity_search.return_value = []
    monkeypatch.setattr(services, "get_vector_store", lambda: store)
    groq = Mock()
    groq.chat.completions.create.return_value = fake_completion()
    monkeypatch.setattr(services, "get_groq", lambda: groq)
    payload = {"messages": [{"role": "user", "content": "I have a headache"}]}
    response = client.post('/chat', headers=HEADERS, json=payload)
    assert response.status_code == 200
    assert response.json()["doctors"][0]["specialty"] == "Neurology"
    assert not response.json()["used_history"]
    profile.assert_not_called()
    assert "hypertension" not in groq.chat.completions.create.call_args.kwargs["messages"][0]["content"]
    payload["medical_record_id"] = RECORD_A
    payload["use_history"] = True
    response = client.post('/chat', headers=HEADERS, json=payload)
    assert response.json()["used_history"]
    assert response.json()["doctors"][0]["specialty"] == "Neurology"
    assert any("shared history" in doctor["match_reason"] for doctor in response.json()["doctors"])
    from uuid import UUID
    profile.assert_called_once_with("medical_records", UUID(RECORD_A), USER_A, "user-a-token")
    # Follow-up timing details retain symptom context from the user, not the assistant.
    payload = {"messages": [
        {"role": "user", "content": "I have a headache"},
        {"role": "assistant", "content": "Hypertension and skin rash are examples."},
        {"role": "user", "content": "It started yesterday"},
    ]}
    response = client.post('/chat', json=payload)
    assert response.json()["doctors"][0]["specialty"] == "Neurology"
    assert all(d["specialty"] not in ("Cardiology", "Dermatology") for d in response.json()["doctors"])
    assert "Earlier in this conversation" in response.json()["doctors"][0]["match_reason"]


@pytest.mark.parametrize('configured_model', [None, 'test-multimodal-model'])
def test_chat_and_photo_use_one_model_setting(client, monkeypatch, configured_model):
    if configured_model:
        monkeypatch.setenv('AI_MODEL', configured_model)
    # Stale deployment variables must not silently restore a second model.
    monkeypatch.setenv('CHAT_MODEL', 'old-chat-model')
    monkeypatch.setenv('VISION_MODEL', 'old-vision-model')
    store = Mock()
    store.similarity_search.return_value = []
    monkeypatch.setattr(services, 'get_vector_store', lambda: store)
    groq = Mock()
    groq.chat.completions.create.return_value = fake_completion('Readable output')
    monkeypatch.setattr(services, 'get_groq', lambda: groq)
    assert client.post('/chat', json={'messages': [{'role': 'user', 'content': 'I have headaches'}]}).status_code == 200
    chat_options = groq.chat.completions.create.call_args.kwargs
    assert client.post('/history/extract', headers=HEADERS, data={'consent': 'true'},
                       files={'image': ('report.png', image_bytes(), 'image/png')}).status_code == 200
    photo_options = groq.chat.completions.create.call_args.kwargs
    assert chat_options['model'] == photo_options['model'] == (configured_model or services.DEFAULT_AI_MODEL)
    if configured_model is None:
        for options in (chat_options, photo_options):
            assert options['reasoning_effort'] == 'none'
            assert options['reasoning_format'] == 'hidden'
    else:
        assert 'reasoning_format' not in chat_options
    prompt = chat_options['messages'][0]['content']
    assert 'Do not duplicate those details in Markdown tables' in prompt
    assert 'If asked about authenticity, explain honestly' in prompt


@pytest.mark.parametrize('path,method', [('/medical-records','get'),('/medical-records','post'),('/conversations','get'),('/conversations','post'),('/conversations/'+RECORD_A,'get'),('/conversations/'+RECORD_A,'delete')])
def test_new_storage_routes_require_login(client, path, method):
    kwargs = {'json': {'name':'History','history':{}}} if method == 'post' and 'medical-records' in path else ({'json': {}} if method == 'post' else {})
    assert getattr(client, method)(path, **kwargs).status_code == 401


def test_chat_uses_only_selected_record_and_checks_owner(client, monkeypatch):
    fetch = Mock(side_effect=main.HTTPException(404, 'Not found'))
    monkeypatch.setattr(services, 'owned_row', fetch)
    payload = {'messages':[{'role':'user','content':'Help with headaches'}], 'use_history':True}
    assert client.post('/chat',headers=HEADERS,json=payload).status_code == 422
    fetch.assert_not_called()
    payload['medical_record_id'] = RECORD_A
    assert client.post('/chat',headers=HEADERS,json=payload).status_code == 404
    from uuid import UUID
    fetch.assert_called_once_with('medical_records',UUID(RECORD_A),USER_A,'user-a-token')


def test_conversation_titles_are_short_and_derived_without_inference():
    from schemas import SavedMessage
    def title(text): return main.short_chat_title([SavedMessage(role='user',content=text)])
    assert title('I have recurring headaches. Who could I consult?') == 'Recurring headaches'
    assert title('Please help me understand symptoms of diabetes') == 'Symptoms of diabetes'
    assert title('What are the symptoms of asthma?') == 'Symptoms of asthma'
    assert title('???') == 'New chat'
    assert len(title('x'*100)) <= 60
    assert title('Find a doctor for migraines') == 'Doctor for migraines'


def test_conversation_create_and_update_validate_owner_selection_and_revision(client, monkeypatch):
    owned = Mock(return_value={'history':{'conditions':'Asthma'}})
    monkeypatch.setattr(services,'owned_row',owned)
    write = Mock(return_value=[{'id':RECORD_A,'revision':1,'title':'Headaches'}])
    monkeypatch.setattr(services,'supabase_request',write)
    body = {'messages':[{'role':'user','content':'I have headaches. What next?'}], 'medical_record_id':RECORD_A,'use_history':True}
    result = client.post('/conversations',headers=HEADERS,json=body)
    assert result.status_code == 201
    saved = write.call_args.kwargs['json']
    assert saved['title'] == 'Headaches'
    assert saved['user_id'] == USER_A
    assert saved['medical_record_id'] == RECORD_A
    assert client.post('/conversations',headers=HEADERS,json={**body,'title':'Injected title'}).status_code == 422
    assert client.post('/conversations',headers=HEADERS,json={**body,'user_id':USER_B}).status_code == 422
    assert client.post('/conversations',headers=HEADERS,json={**body,'medical_record_id':None}).status_code == 422
    write.return_value = []
    result = client.put('/conversations/'+RECORD_A,headers=HEADERS,json={**body,'revision':7})
    assert result.status_code == 409
    assert write.call_args.kwargs['params'] == {'id':'eq.'+RECORD_A,'user_id':'eq.'+USER_A,'revision':'eq.7'}
    assert write.call_args.kwargs['json']['revision'] == 8


def test_conversation_listing_paginates_without_returning_messages(client, monkeypatch):
    query = Mock(return_value=[{'id':str(i)} for i in range(3)])
    monkeypatch.setattr(services,'supabase_request',query)
    result = client.get('/conversations?limit=2&offset=4',headers=HEADERS)
    assert result.json() == {'conversations':[{'id':'0'},{'id':'1'}],'has_more':True}
    params = query.call_args.kwargs['params']
    assert params['user_id'] == 'eq.'+USER_A
    assert 'messages' not in params['select']
    assert params['limit'] == '3' and params['offset'] == '4'
    assert result.headers['cache-control'] == 'no-store'


def test_conversation_restores_catalog_cards_and_delete_is_owner_scoped(client, monkeypatch):
    from uuid import UUID
    owned = Mock(return_value={'id':RECORD_A,'messages':[{'role':'assistant','content':'Explore these profiles.',
        'doctor_matches':[{'id':'demo-02','reason':'Current headache'},{'id':'unknown','reason':'Forged'}]}]})
    monkeypatch.setattr(services,'owned_row',owned)
    result = client.get('/conversations/'+RECORD_A,headers=HEADERS)
    assert result.status_code == 200
    doctors = result.json()['conversation']['messages'][0]['doctors']
    assert len(doctors) == 1
    assert doctors[0]['id'] == 'demo-02' and doctors[0]['match_reason'] == 'Current headache'
    owned.assert_called_with('conversations',UUID(RECORD_A),USER_A,'user-a-token')
    remove = Mock(return_value=None)
    monkeypatch.setattr(services,'supabase_request',remove)
    assert client.delete('/conversations/'+RECORD_A,headers=HEADERS).status_code == 204
    assert remove.call_args.kwargs['params'] == {'id':'eq.'+RECORD_A,'user_id':'eq.'+USER_A}
