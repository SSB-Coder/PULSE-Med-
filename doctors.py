"""Deterministic matching against fictional profiles; never invent credentials."""
import json
import re
from pathlib import Path

DOCTORS = json.loads((Path(__file__).parent / "data/doctors.json").read_text())


def tokens(text):
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def matched_terms(text, doctor):
    # Ignore simple explicit negations; matching is lexical, never a diagnosis.
    normalized = " ".join(re.findall(r"[a-z0-9]+|[.,;!?\n]", text.lower()))
    matches = []
    for term in doctor["keywords"]:
        phrase = r"\b" + r"\s+".join(map(re.escape, term.lower().split())) + r"\b"
        for occurrence in re.finditer(phrase, normalized):
            prefix = normalized[:occurrence.start()]
            if not re.search(r"\b(?:no|not|without|denies|denied|never)\b(?:\s+\w+){0,3}\s*$", prefix):
                matches.append(term)
                break
    return matches


def recommend_doctors(query, city="", specialty="", max_fee=None, limit=3,
                      history=None, previous_symptoms=""):
    """Rank catalog facts by current concerns, previous user turns, then shared history."""
    history_text = "\n".join((history or {}).values())
    results = []
    for doctor in DOCTORS:
        if city and city.casefold() not in doctor["city"].casefold():
            continue
        if specialty and specialty.casefold() != doctor["specialty"].casefold():
            continue
        if max_fee is not None and doctor["fee_inr"] > max_fee:
            continue
        current = matched_terms(query, doctor)
        previous = matched_terms(previous_symptoms, doctor)
        historical = matched_terms(history_text, doctor)
        if (query.strip() or history_text or previous_symptoms) and not (current or previous or historical):
            continue
        result = {k: v for k, v in doctor.items() if k != "keywords"}
        reasons = []
        if current:
            reasons.append("Your current message mentions: " + ", ".join(current))
        if previous:
            reasons.append("Earlier in this conversation you mentioned: " + ", ".join(previous))
        if historical:
            reasons.append("Your shared history mentions: " + ", ".join(historical))
        result["match_reason"] = "; ".join(reasons) + "." if reasons else "Matches your selected directory filters."
        # Current concerns always outrank matches from earlier turns or history alone.
        results.append(((bool(current), len(current), bool(previous), len(previous), len(historical)), result))
    results.sort(key=lambda pair: (tuple(-part for part in pair[0]), pair[1]["id"]))
    return [item for _, item in results[:limit]]


def asks_for_doctor(text):
    return bool(re.search(r"\b(doctor|doctors|specialist|specialists|physician|physicians|cardiologist|neurologist|dermatologist)\b", text, re.I))
