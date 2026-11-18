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


def test_profile_read_and_delete_use_authenticated_owner(client, monkeypatch):
    read = Mock(return_value={"history": {"allergies": "Penicillin"}})
    monkeypatch.setattr(services, "get_profile", read)
    response = client.get("/profile", headers=HEADERS, params={"user_id": USER_B})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    read.assert_called_once_with(USER_A, "user-a-token")
    delete = Mock(return_value=None)
    monkeypatch.setattr(services, "supabase_request", delete)
    assert client.delete("/profile", headers=HEADERS).status_code == 204
    assert delete.call_args.kwargs["params"]["user_id"] == "eq." + USER_A


def test_profile_cannot_spoof_owner_or_extra_fields(client, monkeypatch):
    write = Mock(return_value=[{"history": {"conditions": "Asthma"}, "updated_at": "2026-11-17"}])
    monkeypatch.setattr(services, "supabase_request", write)
    assert client.put("/profile", headers=HEADERS, json={"user_id": USER_B, "history": {}}).status_code == 422
    assert client.put("/profile", headers=HEADERS, json={"history": {"user_id": USER_B}}).status_code == 422
    assert client.put("/profile", headers=HEADERS, json={"history": {"allergies": "a" * 2001}}).status_code == 422
    response = client.put("/profile", headers=HEADERS, json={"history": {"conditions": "Asthma"}})
    assert response.status_code == 200
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
    monkeypatch.setattr(services, "get_profile", profile)
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
    monkeypatch.setattr(services, "get_profile", profile)
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
    payload["use_history"] = True
    response = client.post('/chat', headers=HEADERS, json=payload)
    assert response.json()["used_history"]
    assert response.json()["doctors"][0]["specialty"] == "Neurology"
    assert any("shared history" in doctor["match_reason"] for doctor in response.json()["doctors"])
    profile.assert_called_once_with(USER_A, "user-a-token")
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
