"""Shared, network-free validation for approved public-health evidence."""
import re
import unicodedata
from urllib.parse import urlsplit, urlunsplit

HEALTH_DOMAINS = ('nhs.uk', 'medlineplus.gov', 'cdc.gov', 'nih.gov', 'who.int',
                  'mohfw.gov.in', 'icmr.gov.in', 'fda.gov')
SEARCH_HOST = 'html.duckduckgo.com'
MEDLINE_HOST = 'wsearch.nlm.nih.gov'
MAX_QUERY = 180


def approved_url(value, domains=HEALTH_DOMAINS):
    if not isinstance(value, str) or not value or len(value) > 2000:
        raise ValueError('Invalid source URL.')
    if re.search(r'[\x00-\x20\x7f\\]', value):
        raise ValueError('Invalid source URL.')
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or '').lower()
        if (parsed.scheme != 'https' or parsed.username is not None or parsed.password is not None
                or parsed.port not in (None, 443) or not host.isascii()
                or not any(host == root or host.endswith('.' + root) for root in domains)):
            raise ValueError('Only approved HTTPS health sources are allowed.')
        return urlunsplit(('https', host, parsed.path or '/', parsed.query, ''))
    except (ValueError, UnicodeError):
        raise ValueError('Only approved HTTPS health sources are allowed.') from None


def approved_query(value):
    if not isinstance(value, str):
        raise ValueError('Enter generic public search terms.')
    query = ' '.join(unicodedata.normalize('NFKC', value).split())
    # Deliberately narrow: no URLs/operators, dates, contact details, or pasted narratives.
    if not 3 <= len(query) <= MAX_QUERY or any(not (c.isalpha() or c.isdigit() or c in ' -') for c in query):
        raise ValueError('Use 3-180 characters: generic words, spaces, and hyphens; no links or identifiers.')
    if re.search(r'\d{3,}', query) or re.search(
        r'\b(i|my|me|mine|our|we|name|patient|dob|born|address|phone|email|mrn|passport|aadhaar|aadhar|ssn)\b', query, re.I
    ):
        raise ValueError('Remove personal details. Use generic health topics, such as migraine guidance.')
    return query
