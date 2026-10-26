"""Custom Presidio recognizers and the mapping from Presidio entity types to Privara categories."""

from __future__ import annotations

import re

from presidio_analyzer import Pattern, PatternRecognizer

# Privara category -> Presidio entity types that produce it.
CATEGORY_ENTITIES: dict[str, list[str]] = {
    "PERSON": ["PERSON", "PERSON_FALLBACK"],
    "EMAIL": ["EMAIL_ADDRESS"],
    "PHONE": ["PHONE_NUMBER", "NG_PHONE"],
    "AMOUNT": ["AMOUNT"],
    "CARD": ["CREDIT_CARD"],
    "IBAN": ["IBAN_CODE"],
    "IP": ["IP_ADDRESS"],
    "LOCATION": ["LOCATION"],
    "URL": ["URL"],
    "NATIONAL_ID": ["US_SSN", "UK_NINO", "NG_NIN", "NG_BVN"],
    "CRYPTO": ["CRYPTO"],
    "DATE": ["DATE_TIME"],
}

ENTITY_TO_CATEGORY: dict[str, str] = {
    entity: category for category, entities in CATEGORY_ENTITIES.items() for entity in entities
}

ALL_CATEGORIES: list[str] = list(CATEGORY_ENTITIES)
DEFAULT_CATEGORIES: list[str] = [c for c in ALL_CATEGORIES if c != "DATE"]

CATEGORY_LABELS: dict[str, str] = {
    "PERSON": "Person names",
    "EMAIL": "Email addresses",
    "PHONE": "Phone numbers",
    "AMOUNT": "Monetary amounts",
    "CARD": "Payment card numbers",
    "IBAN": "IBAN bank codes",
    "IP": "IP addresses",
    "LOCATION": "Locations",
    "URL": "URLs",
    "NATIONAL_ID": "National IDs (SSN, NIN, BVN, NINO)",
    "CRYPTO": "Crypto wallet addresses",
    "DATE": "Dates and times",
}

_CURRENCY_PREFIX = r"(?:₦|NGN|N(?=\d)|US\$|\$|USD|€|EUR|£|GBP|KES|GHS|ZAR|R(?=\d))"
_NUMBER = r"\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?"
_SCALE = r"(?:\s?(?:k|K|m|M|bn|million|billion|thousand))?"
_CURRENCY_WORD = r"(?:naira|NGN|dollars?|USD|euros?|EUR|pounds?|GBP|kobo|cedis?|shillings?)"


def amount_recognizer() -> PatternRecognizer:
    return PatternRecognizer(
        supported_entity="AMOUNT",
        name="PrivaraAmountRecognizer",
        patterns=[
            Pattern(
                "currency-prefixed amount",
                rf"(?<![A-Za-z0-9]){_CURRENCY_PREFIX}\s?(?:{_NUMBER}){_SCALE}(?![\d,])",
                0.85,
            ),
            Pattern(
                "amount followed by currency word",
                rf"(?<![A-Za-z0-9.,])(?:{_NUMBER}){_SCALE}\s?{_CURRENCY_WORD}\b",
                0.8,
            ),
        ],
    )


def nigerian_phone_recognizer() -> PatternRecognizer:
    return PatternRecognizer(
        supported_entity="NG_PHONE",
        name="PrivaraNigerianPhoneRecognizer",
        patterns=[
            Pattern(
                "Nigerian mobile number",
                r"(?<!\d)(?:\+?234[\s-]?|0)[789][01]\d[\s-]?\d{3}[\s-]?\d{4}(?!\d)",
                0.7,
            )
        ],
        context=["phone", "call", "mobile", "tel", "whatsapp", "number", "line"],
    )


def nigerian_id_recognizers() -> list[PatternRecognizer]:
    return [
        PatternRecognizer(
            supported_entity="NG_NIN",
            name="PrivaraNINRecognizer",
            patterns=[Pattern("11-digit NIN", r"(?<!\d)\d{11}(?!\d)", 0.1)],
            context=["nin", "national identification", "identity number", "nimc"],
        ),
        PatternRecognizer(
            supported_entity="NG_BVN",
            name="PrivaraBVNRecognizer",
            patterns=[Pattern("11-digit BVN", r"(?<!\d)22\d{9}(?!\d)", 0.15)],
            context=["bvn", "bank verification"],
        ),
    ]


# Used only when no spaCy NER model can be loaded. Deliberately conservative.
PERSON_FALLBACK_STOPWORDS = {
    "send", "please", "the", "dear", "hi", "hello", "call", "email", "pay", "ask", "tell",
    "invoice", "from", "to", "for", "with", "and", "mr", "mrs", "ms", "dr", "monday",
    "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january",
    "february", "march", "april", "may", "june", "july", "august", "september", "october",
    "november", "december", "thanks", "regards", "best", "kind", "this", "that", "our",
}


# Common words the small spaCy model sometimes tags as PERSON at the start of a sentence.
NOT_A_NAME = PERSON_FALLBACK_STOPWORDS | {
    "email", "e-mail", "kick-off", "kickoff", "budget", "primary", "contact", "client", "brief", "reminder",
    "note", "notes", "meeting", "subject", "re", "fwd", "attachment", "approved", "remind", "write", "draft",
    "urgent", "update", "agenda", "summary", "total", "amount", "balance", "due", "phone", "mobile",
}


def is_common_word_span(span: str) -> bool:
    words = [w.strip(".,:;!?()[]{}'\"").lower() for w in span.split()]
    words = [w for w in words if w]
    return bool(words) and all(w in NOT_A_NAME for w in words)


def person_fallback_recognizer() -> PatternRecognizer:
    return PatternRecognizer(
        supported_entity="PERSON_FALLBACK",
        name="PrivaraPersonHeuristic",
        patterns=[
            Pattern(
                "capitalised name run",
                r"\b[A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+){1,3}\b",
                0.45,
            )
        ],
    )


def trim_fallback_person(text: str, start: int, end: int) -> tuple[int, int] | None:
    """Strip leading/trailing stop words from a heuristic name match; drop if <2 words remain."""
    words = [(m.start() + start, m.end() + start, m.group()) for m in re.finditer(r"\S+", text[start:end])]
    while words and words[0][2].lower() in PERSON_FALLBACK_STOPWORDS:
        words.pop(0)
    while words and words[-1][2].lower() in PERSON_FALLBACK_STOPWORDS:
        words.pop()
    if len(words) < 2:
        return None
    return words[0][0], words[-1][1]
