"""Small, opt-in search of PubMed abstracts through NCBI E-utilities."""
import os
import time
from threading import Lock
from xml.etree import ElementTree

import httpx


BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
RESULT_LIMIT = 5
CACHE_TTL = 15 * 60
CACHE_LIMIT = 64
# Two starts per second per worker, leaving room below NCBI's no-key limit.
REQUEST_INTERVAL = 0.5
_search_lock = Lock()
_next_request = 0.0
_cache = {}


class PubMedBusy(Exception):
    pass


def _request(client, utility, **params):
    global _next_request
    time.sleep(max(0.0, _next_request - time.monotonic()))
    _next_request = time.monotonic() + REQUEST_INTERVAL
    contact_email = os.getenv("PUBMED_CONTACT_EMAIL", "").strip()
    if contact_email:
        params["email"] = contact_email
    response = client.get(f"{BASE_URL}/{utility}.fcgi", params={
        "db": "pubmed", "tool": "pulse_medical", **params,
    })
    response.raise_for_status()
    return response


def _text(node):
    return " ".join("".join(node.itertext()).split()) if node is not None else ""


def _records(xml, ids):
    root = ElementTree.fromstring(xml)
    if root.tag != "PubmedArticleSet" or root.find("ERROR") is not None:
        raise ValueError("Unexpected PubMed response")
    records = {}
    for item in root.findall("PubmedArticle"):
        citation = item.find("MedlineCitation")
        if citation is None:
            continue
        pmid = citation.findtext("PMID", "")
        article = citation.find("Article")
        if pmid not in ids or article is None:
            continue
        # Corrections and retraction notices remain visible via the PubMed record.
        publication_types = [_text(node) for node in article.findall("PublicationTypeList/PublicationType")]
        if {"Retracted Publication", "Retraction of Publication"} & set(publication_types):
            continue
        sections = []
        for section in article.findall("Abstract/AbstractText"):
            content = _text(section)
            if content:
                label = section.get("Label")
                sections.append(f"{label}: {content}" if label else content)
        date_path = "Journal/JournalIssue/PubDate/"
        year = article.findtext(date_path + "Year") or article.findtext("ArticleDate/Year") or ""
        records[pmid] = {
            "pmid": pmid,
            "title": _text(article.find("ArticleTitle"))[:500] or "PubMed record",
            "year": year if len(year) == 4 and year.isascii() and year.isdigit() else "",
            "publication_types": publication_types[:10],
            "abstract": "\n".join(sections)[:4000],
        }
    return [records[pmid] for pmid in ids if pmid in records]


def search(query):
    """Return bounded abstracts in search order. The cache stores only research searches."""
    if not _search_lock.acquire(blocking=False):
        raise PubMedBusy
    try:
        now = time.monotonic()
        for key, (expires, _) in list(_cache.items()):
            if expires <= now:
                del _cache[key]
        if query in _cache:
            return _cache[query][1]
        with httpx.Client(timeout=8.0) as client:
            result = _request(client, "esearch", term=query, retmax=RESULT_LIMIT,
                              sort="relevance", retmode="json").json()["esearchresult"]
            if result.get("errorlist") or result.get("ERROR"):
                raise ValueError("PubMed could not process the search")
            ids = list(dict.fromkeys(pmid for pmid in result["idlist"]
                                     if isinstance(pmid, str) and pmid.isascii() and pmid.isdigit()))[:RESULT_LIMIT]
            records = _records(_request(client, "efetch", id=",".join(ids),
                                        retmode="xml").content, ids) if ids else []
        if len(_cache) >= CACHE_LIMIT:
            del _cache[next(iter(_cache))]
        _cache[query] = (time.monotonic() + CACHE_TTL, records)
        return records
    finally:
        _search_lock.release()
