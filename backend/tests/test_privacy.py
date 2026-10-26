from privara.config import Settings
from privara.core import build

from .conftest import PII, SAMPLE, make_settings


def test_example_sentence_is_redacted_exactly(gateway, agent):
    result = gateway.sanitize_text(agent, SAMPLE, "s1", channel="test")
    assert result["status"] == "sanitized"
    assert result["sanitized_text"] == "Send [PERSON_1] the invoice for [AMOUNT_1] at [EMAIL_1]."
    assert result["entity_categories"] == ["AMOUNT", "EMAIL", "PERSON"]
    assert result["redaction_count"] == 3
    assert result["redaction_session_id"].startswith("rs_")
    for value in PII.values():
        assert value not in result["sanitized_text"]


def test_placeholders_are_deterministic_within_a_session(gateway, agent):
    first = gateway.sanitize_text(agent, SAMPLE, "s1", channel="test")
    second = gateway.sanitize_text(
        agent, "Reminder: john@example.com still owes ₦250,000. Also cc mary@example.com.", "s1", channel="test"
    )
    assert second["redaction_session_id"] == first["redaction_session_id"]
    assert "[EMAIL_1]" in second["sanitized_text"] and "[AMOUNT_1]" in second["sanitized_text"]
    assert "[EMAIL_2]" in second["sanitized_text"]  # a new value gets a new number


def test_repeated_entity_in_one_text_reuses_placeholder(gateway, agent):
    result = gateway.sanitize_text(agent, "Email john@example.com, then JOHN@example.com again.", "s2", channel="test")
    assert result["sanitized_text"].count("[EMAIL_1]") == 2
    assert result["redaction_count"] == 2
    assert len(result["placeholders"]) == 1


def test_sessions_are_isolated(gateway, agent):
    a = gateway.sanitize_text(agent, "Write to alice@example.com", "a", channel="test")
    b = gateway.sanitize_text(agent, "Write to bob@example.com", "b", channel="test")
    assert a["redaction_session_id"] != b["redaction_session_id"]
    assert "[EMAIL_1]" in a["sanitized_text"] and "[EMAIL_1]" in b["sanitized_text"]


def test_category_configuration_limits_detection(gateway, agent):
    result = gateway.sanitize_text(agent, SAMPLE, "s3", {"categories": ["EMAIL"]}, channel="test")
    assert result["sanitized_text"] == "Send John Okafor the invoice for ₦250,000 at [EMAIL_1]."


def test_more_entity_types(gateway, agent):
    text = "Call 0803 123 4567, card 4111 1111 1111 1111, IP 10.0.0.12, NIN 12345678901."
    result = gateway.sanitize_text(agent, text, "s4", channel="test")
    assert {"PHONE", "CARD", "IP", "NATIONAL_ID"} <= set(result["entity_categories"])
    for raw in ("0803 123 4567", "4111 1111 1111 1111", "10.0.0.12", "12345678901"):
        assert raw not in result["sanitized_text"]


def test_vault_stores_ciphertext_not_plaintext(container, gateway, agent):
    gateway.sanitize_text(agent, SAMPLE, "s5", channel="test")
    for suffix in ("", "-wal"):
        path = container.settings.vault_db_path.with_name(container.settings.vault_db_path.name + suffix)
        if path.exists():
            raw = path.read_bytes()
            for value in PII.values():
                assert value.encode() not in raw


def test_pattern_only_fallback_when_nlp_unavailable(tmp_path):
    settings = make_settings(tmp_path, nlp_enabled=False)
    container = build(settings)
    assert container.privacy.detector.mode == "presidio-patterns"
    _, key = container.agents.create("fallback-agent")
    agent = container.agents.authenticate(key)
    result = container.gateway.sanitize_text(agent, SAMPLE, "s", channel="test")
    assert "[EMAIL_1]" in result["sanitized_text"] and "[AMOUNT_1]" in result["sanitized_text"]
    assert result["detector"]["fallback_reason"]


def test_missing_model_falls_back_cleanly(tmp_path):
    container = build(make_settings(tmp_path, nlp_model="xx_model_that_does_not_exist"))
    described = container.privacy.detector.describe()
    assert described["mode"] == "presidio-patterns"
    assert "could not be loaded" in described["fallback_reason"]


def test_high_sensitivity_adds_name_heuristic(gateway, agent):
    text = "Pay Amina Bello $1,200 at amina@example.org"
    balanced = gateway.sanitize_text(agent, text, "h1", {"level": "medium"}, channel="test")
    high = gateway.sanitize_text(agent, text, "h2", {"level": "high"}, channel="test")
    assert "Amina Bello" not in high["sanitized_text"] and "[PERSON_1]" in high["sanitized_text"]
    assert high["redaction_count"] >= balanced["redaction_count"]
