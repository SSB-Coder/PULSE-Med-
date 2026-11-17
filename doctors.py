"""Deterministic matching against fictional profiles; never invent credentials."""
import json
import re
from pathlib import Path

DOCTORS = json.loads((Path(__file__).parent / "data/doctors.json").read_text())


def tokens(text):
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def recommend_doctors(query, city="", specialty="", max_fee=None, limit=3):
    query_tokens = tokens(query)
    results = []
    for doctor in DOCTORS:
        if city and city.casefold() not in doctor["city"].casefold():
            continue
        if specialty and specialty.casefold() != doctor["specialty"].casefold():
            continue
        if max_fee is not None and doctor["fee_inr"] > max_fee:
            continue
        matches = [term for term in doctor["keywords"] if tokens(term) <= query_tokens]
        # No symptom-to-specialty inference when there are no matching terms.
        if query.strip() and not matches:
            continue
        result = {k: v for k, v in doctor.items() if k != "keywords"}
        result["match_reason"] = (
            "Listed interests match: " + ", ".join(matches) + "."
            if matches else "Matches your selected directory filters."
        )
        results.append((len(matches), result))
    results.sort(key=lambda pair: (-pair[0], pair[1]["id"]))
    return [item for _, item in results[:limit]]


def asks_for_doctor(text):
    return bool(re.search(r"\b(doctor|doctors|specialist|specialists|physician|physicians|cardiologist|neurologist|dermatologist)\b", text, re.I))
