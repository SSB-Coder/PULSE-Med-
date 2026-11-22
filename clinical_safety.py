"""Conservative interruption for a few explicit red flags; not a triage classifier.

Background: NHS headache / shortness-of-breath / stroke-symptom guidance. A negative result never
means safe or excludes an emergency; the main prompt still assesses urgency.
"""
import re

RED_FLAGS = re.compile(
    r"\b(?:can(?:not|'t|’t) breathe|severe difficulty breathing|struggling to breathe|"
    r"(?:sudden(?:ly)?\s+(?:very\s+|extremely\s+)?(?:severe|painful)\s+headache)|"
    r"worst headache(?: of my life)?|new (?:one sided|one-sided) weakness|"
    r"chest pain (?:with|and) (?:shortness of breath|difficulty breathing))\b", re.I)


def possible_emergency(text):
    for match in RED_FLAGS.finditer(text):
        prefix = re.split(r'[.;!?\n]|\bbut\b', text[:match.start()], flags=re.I)[-1]
        if not re.search(r'\b(?:no|not|never|without)\b(?:\s+\w+){0,2}\s*$', prefix, re.I):
            return True
    return False


URGENT_REPLY = (
    'The symptoms you describe could need immediate medical attention. If they are happening now, '
    'contact your local emergency service or seek urgent in-person care. Do not wait for web search '
    'or an online assessment. I cannot determine the cause through chat. '
    'If you meant a past event or a general question, clarify that after addressing any current symptoms.\n\n'
    'I am an AI, not a doctor. This information is educational and does not replace professional medical advice.'
)
