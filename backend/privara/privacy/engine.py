"""PII detection (Presidio) and deterministic, session-scoped redaction."""

from __future__ import annotations

import logging
import re
import threading
from dataclasses import asdict, dataclass, field
from types import SimpleNamespace

from .recognizers import (
    ALL_CATEGORIES,
    CATEGORY_ENTITIES,
    DEFAULT_CATEGORIES,
    ENTITY_TO_CATEGORY,
    amount_recognizer,
    is_common_word_span,
    nigerian_id_recognizers,
    nigerian_phone_recognizer,
    person_fallback_recognizer,
    trim_fallback_person,
)
from .vault import Vault

log = logging.getLogger("privara.privacy")

LEVEL_THRESHOLDS = {"low": 0.6, "medium": 0.4, "high": 0.25}
# At or below this threshold ("high" sensitivity) the capitalised-name heuristic supplements NER.
HEURISTIC_MAX_THRESHOLD = 0.3
PLACEHOLDER_RE = re.compile(r"\[([A-Z_]+)_(\d+)\]")


@dataclass
class DetectedEntity:
    category: str
    start: int
    end: int
    score: float
    placeholder: str = ""
    sanitized_start: int = 0
    sanitized_end: int = 0
    detector: str = ""


@dataclass
class SanitizeOutcome:
    sanitized_text: str
    entities: list[DetectedEntity] = field(default_factory=list)

    @property
    def categories(self) -> list[str]:
        return sorted({e.category for e in self.entities})

    @property
    def redaction_count(self) -> int:
        return len(self.entities)

    def category_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for entity in self.entities:
            counts[entity.category] = counts.get(entity.category, 0) + 1
        return counts

    def spans(self) -> list[dict]:
        return [asdict(e) for e in self.entities]


def _offline_tldextract() -> None:
    """Presidio's email recognizer uses tldextract, which downloads the Public Suffix List on
    first use. A privacy gateway must not make outbound requests, so force the bundled snapshot."""
    import tldextract
    from presidio_analyzer.predefined_recognizers import email_recognizer

    extractor = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None)
    email_recognizer.tldextract = SimpleNamespace(extract=extractor)


class Detector:
    """Wraps a Presidio AnalyzerEngine. Loading spaCy is slow, so instances are cached."""

    _cache: dict[tuple[bool, str], "Detector"] = {}
    _lock = threading.Lock()

    def __init__(self, nlp_enabled: bool, model: str):
        from presidio_analyzer import AnalyzerEngine, RecognizerRegistry
        from presidio_analyzer.nlp_engine import SpacyNlpEngine
        from presidio_analyzer.predefined_recognizers import PhoneRecognizer

        _offline_tldextract()

        nlp_engine = SpacyNlpEngine(models=[{"lang_code": "en", "model_name": model}])
        self.mode = "presidio+spacy"
        self.model = model
        self.fallback_reason: str | None = None
        if nlp_enabled:
            # Load the model ourselves: Presidio's own load() would try to *download* a missing model,
            # which is an outbound network call and exits the process on failure.
            import spacy

            try:
                nlp_engine.nlp = {"en": spacy.load(model)}
            except (OSError, ImportError, ValueError) as exc:  # model not installed / incompatible
                self.fallback_reason = f"spaCy model '{model}' could not be loaded ({type(exc).__name__})"
        else:
            self.fallback_reason = "NLP disabled by configuration (PRIVARA_NLP_ENABLED=false)"

        if self.fallback_reason:
            import spacy

            nlp_engine.nlp = {"en": spacy.blank("en")}
            self.mode = "presidio-patterns"
            self.model = None
            log.warning("PII detection running in pattern-only fallback: %s", self.fallback_reason)

        registry = RecognizerRegistry(supported_languages=["en"])
        registry.load_predefined_recognizers(languages=["en"], nlp_engine=nlp_engine)
        registry.remove_recognizer("PhoneRecognizer")
        registry.add_recognizer(PhoneRecognizer(supported_regions=("NG", "US", "GB", "GH", "KE", "ZA", "DE", "FR")))
        registry.add_recognizer(amount_recognizer())
        registry.add_recognizer(nigerian_phone_recognizer())
        for recognizer in nigerian_id_recognizers():
            registry.add_recognizer(recognizer)
        # Always registered; used when there is no NER model, or at the "high" sensitivity level
        # where catching more names is worth some over-redaction.
        registry.add_recognizer(person_fallback_recognizer())

        self.engine = AnalyzerEngine(nlp_engine=nlp_engine, registry=registry, supported_languages=["en"])
        self.supported_entities = set(self.engine.get_supported_entities(language="en"))

    @classmethod
    def get(cls, nlp_enabled: bool, model: str) -> "Detector":
        key = (nlp_enabled, model)
        with cls._lock:
            if key not in cls._cache:
                cls._cache[key] = cls(nlp_enabled, model)
            return cls._cache[key]

    def describe(self) -> dict:
        return {"mode": self.mode, "model": self.model, "fallback_reason": self.fallback_reason}

    def detect(self, text: str, categories: list[str], threshold: float) -> list[DetectedEntity]:
        use_heuristic = self.fallback_reason is not None or threshold <= HEURISTIC_MAX_THRESHOLD
        entities = sorted(
            {
                e
                for c in categories
                for e in CATEGORY_ENTITIES.get(c, [])
                if e in self.supported_entities and (e != "PERSON_FALLBACK" or use_heuristic)
            }
        )
        if not entities or not text.strip():
            return []
        results = self.engine.analyze(text=text, language="en", entities=entities, score_threshold=threshold)
        found: list[DetectedEntity] = []
        for result in results:
            start, end = result.start, result.end
            if result.entity_type == "PERSON_FALLBACK":
                trimmed = trim_fallback_person(text, start, end)
                if not trimmed:
                    continue
                start, end = trimmed
            if result.entity_type == "PERSON" and is_common_word_span(text[start:end]):
                continue
            found.append(
                DetectedEntity(
                    category=ENTITY_TO_CATEGORY[result.entity_type],
                    start=start,
                    end=end,
                    score=round(float(result.score), 3),
                    detector=result.entity_type,
                )
            )
        return _resolve_overlaps(found)


def _resolve_overlaps(entities: list[DetectedEntity]) -> list[DetectedEntity]:
    """Keep the strongest, then longest, span wherever detections overlap."""
    kept: list[DetectedEntity] = []
    for candidate in sorted(entities, key=lambda e: (-e.score, -(e.end - e.start), e.start)):
        if all(candidate.end <= k.start or candidate.start >= k.end for k in kept):
            kept.append(candidate)
    return sorted(kept, key=lambda e: e.start)


@dataclass
class SensitivityConfig:
    categories: list[str]
    threshold: float

    @classmethod
    def build(
        cls,
        *,
        categories: list[str] | None,
        level: str | None,
        threshold: float | None,
        defaults: list[str],
        default_threshold: float,
    ) -> "SensitivityConfig":
        chosen = [c for c in (categories if categories is not None else defaults) if c in ALL_CATEGORIES]
        if threshold is None:
            threshold = LEVEL_THRESHOLDS.get(level or "", default_threshold)
        return cls(categories=chosen, threshold=max(0.0, min(1.0, threshold)))


class PrivacyEngine:
    def __init__(self, detector: Detector, vault: Vault):
        self.detector = detector
        self.vault = vault

    def sanitize(self, text: str, redaction_session_id: str, config: SensitivityConfig) -> SanitizeOutcome:
        detected = self.detector.detect(text, config.categories, config.threshold)
        out: list[str] = []
        cursor = 0
        length = 0
        for entity in detected:
            entity.placeholder = self.vault.placeholder_for(
                redaction_session_id, entity.category, text[entity.start : entity.end]
            )
            chunk = text[cursor : entity.start]
            out.append(chunk)
            length += len(chunk)
            entity.sanitized_start = length
            out.append(entity.placeholder)
            length += len(entity.placeholder)
            entity.sanitized_end = length
            cursor = entity.end
        out.append(text[cursor:])
        return SanitizeOutcome(sanitized_text="".join(out), entities=detected)

    def restore(self, text: str, redaction_session_id: str) -> tuple[str, int, int]:
        """Replace only placeholders that exist in this session's stored mapping.

        Returns (restored_text, restored_count, unknown_placeholder_count). Placeholders that are
        not part of the session are left untouched — callers can never supply their own mapping.
        """
        mapping = self.vault.resolve(redaction_session_id)
        restored = 0
        unknown = 0

        def substitute(match: re.Match[str]) -> str:
            nonlocal restored, unknown
            value = mapping.get(match.group(0))
            if value is None:
                unknown += 1
                return match.group(0)
            restored += 1
            return value

        return PLACEHOLDER_RE.sub(substitute, text), restored, unknown


__all__ = [
    "ALL_CATEGORIES",
    "DEFAULT_CATEGORIES",
    "Detector",
    "PrivacyEngine",
    "SanitizeOutcome",
    "SensitivityConfig",
]
