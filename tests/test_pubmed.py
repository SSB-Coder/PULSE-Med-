from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient

import main
import pubmed
import services


XML = """<PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID>102</PMID><Article>
  <ArticleTitle>A paper with no abstract</ArticleTitle>
</Article></MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID>101</PMID><Article>
  <ArticleTitle>Research on <i>exercise</i></ArticleTitle>
  <Journal><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal>
  <Abstract><AbstractText Label="RESULTS">Improved <b>some</b> outcomes.</AbstractText></Abstract>
</Article></MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID>103</PMID><Article>
  <ArticleTitle>Retracted paper</ArticleTitle>
  <PublicationTypeList><PublicationType>Retracted Publication</PublicationType></PublicationTypeList>
</Article></MedlineCitation></PubmedArticle>
</PubmedArticleSet>"""


@pytest.fixture
def ncbi(monkeypatch):
    calls = []
    client_class = httpx.Client

    def respond(request):
        calls.append(request)
        assert request.url.host == "eutils.ncbi.nlm.nih.gov"
        assert request.headers.get("Authorization") is None
        if request.url.path.endswith("/esearch.fcgi"):
            assert request.url.params["term"] == "diabetes exercise"
            return httpx.Response(200, json={"esearchresult": {"idlist": ["101", "102", "103", "invalid"]}})
        assert request.url.path.endswith("/efetch.fcgi")
        assert request.url.params["id"] == "101,102,103"
        return httpx.Response(200, text=XML)

    client = TestClient(main.app)
    # Swap only the PubMed HTTP client; Starlette's test client runs the actual API route.
    monkeypatch.setattr(pubmed, "httpx", SimpleNamespace(
        Client=lambda **options: client_class(transport=httpx.MockTransport(respond), **options)))
    monkeypatch.setattr(pubmed, "_cache", {})
    monkeypatch.setattr(pubmed, "_next_request", 0.0)
    monkeypatch.setattr(pubmed, "REQUEST_INTERVAL", 0)
    return client, calls


def mock_summary(monkeypatch, pmid):
    create = Mock(return_value=SimpleNamespace(choices=[SimpleNamespace(
        finish_reason="stop", message=SimpleNamespace(
            content='{"findings":[{"text":"Some outcomes improved.","pmids":["' + pmid + '"]}]}'))]))
    monkeypatch.setattr(services, "get_groq", lambda: SimpleNamespace(chat=SimpleNamespace(
        completions=SimpleNamespace(create=create))))
    return create


def test_search_uses_only_topic_and_cites_available_abstracts(ncbi, monkeypatch):
    client, calls = ncbi
    create = mock_summary(monkeypatch, "101")
    private = Mock(side_effect=AssertionError("Research must not look up the account, history or vector index"))
    for name in ("verify_user", "owned_row", "get_vector_store"):
        monkeypatch.setattr(services, name, private)
    response = client.post("/research/pubmed", json={"query": " diabetes   exercise "})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    data = response.json()
    assert data["status"] == "summarized"
    assert [paper["pmid"] for paper in data["sources"]] == ["101", "102"]
    assert data["sources"][0]["title"] == "Research on exercise"
    assert data["sources"][0]["year"] == "2024"
    assert data["findings"][0]["pmids"] == ["101"]
    model_input = create.call_args.kwargs["messages"][-1]["content"]
    assert "RESULTS: Improved some outcomes." in model_input
    assert "A paper with no abstract" not in model_input
    assert client.post("/research/pubmed", json={"query": "diabetes exercise"}).status_code == 200
    assert len(calls) == 2
    assert client.post("/research/pubmed", json={"query": "diabetes exercise", "history": {}}).status_code == 422
    private.assert_not_called()


@pytest.mark.parametrize("pmid", ["102", "123456"])
def test_bad_citations_keep_sources_without_showing_summary(ncbi, monkeypatch, pmid):
    client, _ = ncbi
    mock_summary(monkeypatch, pmid)
    data = client.post("/research/pubmed", json={"query": "diabetes exercise"}).json()
    assert data["status"] == "summary_unavailable"
    assert data["findings"] == []
    assert len(data["sources"]) == 2


def test_empty_search_skips_groq(monkeypatch):
    monkeypatch.setattr(pubmed, "search", Mock(return_value=[]))
    groq = Mock()
    monkeypatch.setattr(services, "get_groq", groq)
    response = TestClient(main.app).post("/research/pubmed", json={"query": "diabetes exercise"})
    assert response.json() == {"sources": [], "findings": [], "status": "no_results"}
    groq.assert_not_called()


@pytest.mark.parametrize(("error", "status"), [(pubmed.PubMedBusy(), 429), (httpx.ReadTimeout("upstream detail"), 503)])
def test_pubmed_failure_is_explicit(monkeypatch, error, status):
    monkeypatch.setattr(pubmed, "search", Mock(side_effect=error))
    response = TestClient(main.app).post("/research/pubmed", json={"query": "diabetes exercise"})
    assert response.status_code == status
    assert "upstream detail" not in response.text
