import os
from datetime import timedelta

import pytest

from privara.db import utcnow
from privara.errors import AuthenticationError, ForbiddenError, ValidationFailed

from .conftest import PII, SAMPLE, approve_and_collect


# ---- sandbox & path traversal ------------------------------------------------------------------
def test_sandbox_read_is_allowed_and_output_sanitized(gateway, agent):
    result = gateway.execute_tool(agent, "read_file", {"path": "notes/client-brief.txt"}, channel="test")
    assert result["status"] == "executed"
    content = result["result"]["content"]
    assert "amina.bello@example.org" not in content and "[EMAIL_1]" in content
    assert result["result"]["sanitized"] is True


def test_sanitize_output_can_be_disabled(gateway, agent):
    result = gateway.execute_tool(
        agent, "read_file", {"path": "notes/client-brief.txt"}, channel="test", sanitize_output=False
    )
    assert "amina.bello@example.org" in result["result"]["content"]


@pytest.mark.parametrize(
    "path",
    ["../vault.key", "notes/../../privara.db", "/etc/passwd", "~/.ssh/id_rsa", "C:\\Windows\\win.ini",
     "..\\vault.key", "notes/../../../../etc/hosts"],
)
def test_path_traversal_is_denied(gateway, agent, path):
    result = gateway.execute_tool(agent, "read_file", {"path": path}, channel="test")
    assert result["status"] == "denied"
    assert result["resource"].startswith("outside:")


def test_symlink_escape_is_treated_as_outside(container, gateway, agent):
    link = container.sandbox / "notes" / "escape"
    os.symlink(container.settings.data_dir, link)
    result = gateway.execute_tool(agent, "read_file", {"path": "notes/escape/vault.key"}, channel="test")
    assert result["status"] == "denied"


def test_tool_refuses_outside_even_if_policy_allows(container, gateway, agent):
    container.policies.create({
        "name": "dangerous allow", "action": "file.read", "resource": "outside:*", "decision": "allow",
        "priority": 5000,
    })
    result = gateway.execute_tool(agent, "read_file", {"path": "../vault.key"}, channel="test")
    assert result["status"] == "failed"
    assert result["error"]["code"] == "sandbox_violation"


def test_write_to_protected_location_is_denied(container, gateway, agent):
    target = container.sandbox / "protected" / "policy-notice.txt"
    before = target.read_text()
    result = gateway.execute_tool(
        agent, "write_file", {"path": "protected/policy-notice.txt", "content": "pwned", "mode": "overwrite"},
        channel="test",
    )
    assert result["status"] == "denied"
    assert target.read_text() == before


def test_write_inside_sandbox(container, gateway, agent):
    result = gateway.execute_tool(agent, "write_file", {"path": "notes/new/out.txt", "content": "hi"}, channel="test")
    assert result["status"] == "executed"
    assert (container.sandbox / "notes" / "new" / "out.txt").read_text() == "hi"
    again = gateway.execute_tool(agent, "write_file", {"path": "notes/new/out.txt", "content": "x"}, channel="test")
    assert again["status"] == "failed" and again["error"]["code"] == "file_exists"


def test_unregistered_tool_is_denied(gateway, agent):
    result = gateway.execute_tool(agent, "run_shell", {"cmd": "rm -rf /"}, channel="test")
    assert result["status"] == "denied"
    assert result["policy"]["id"] == "pol_seed_unregistered"


def test_unregistered_tool_denied_even_with_allow_policy(container, gateway, agent):
    container.policies.create({"name": "allow all", "action": "*", "resource": "*", "decision": "allow", "priority": 9999})
    assert gateway.execute_tool(agent, "run_shell", {}, channel="test")["status"] == "denied"


def test_arguments_are_validated_without_echoing_values(gateway, agent):
    with pytest.raises(ValidationFailed) as excinfo:
        gateway.execute_tool(agent, "read_file", {"path": "x", "secret": PII["email"]}, channel="test")
    assert PII["email"] not in str(excinfo.value.to_dict())


def test_transform_text_tool(gateway, agent):
    result = gateway.execute_tool(agent, "transform_text", {"operation": "word_count", "text": "a b c"}, channel="test")
    assert result["status"] == "executed" and result["result"]["output"] == 3


# ---- approvals ---------------------------------------------------------------------------------
OUTBOX_ARGS = {"path": "outbox/draft.txt", "content": "Send [PERSON_1] the invoice.", "mode": "overwrite"}


def test_full_approval_flow_and_token_reuse(container, gateway, agent):
    pending = gateway.execute_tool(agent, "write_file", OUTBOX_ARGS, channel="test")
    assert pending["status"] == "approval_required"
    request_id = pending["approval_request_id"]
    assert not (container.sandbox / "outbox" / "draft.txt").exists()

    early = gateway.get_approval(agent, request_id)
    assert early["status"] == "pending" and early["approval_token"] is None

    token = approve_and_collect(container, agent, request_id)
    assert gateway.get_approval(agent, request_id)["approval_token"] is None  # shown once

    executed = gateway.execute_tool(agent, "write_file", OUTBOX_ARGS, token, channel="test")
    assert executed["status"] == "executed"
    assert (container.sandbox / "outbox" / "draft.txt").exists()

    reused = gateway.execute_tool(agent, "write_file", OUTBOX_ARGS, token, channel="test")
    assert reused["status"] == "approval_rejected" and reused["reason"] == "token_reused"


def test_token_cannot_be_used_for_different_arguments(container, gateway, agent):
    request_id = gateway.execute_tool(agent, "write_file", OUTBOX_ARGS, channel="test")["approval_request_id"]
    token = approve_and_collect(container, agent, request_id)
    swapped = {**OUTBOX_ARGS, "content": "something else entirely"}
    result = gateway.execute_tool(agent, "write_file", swapped, token, channel="test")
    assert result["status"] == "approval_rejected" and result["reason"] == "token_action_mismatch"
    other_path = {**OUTBOX_ARGS, "path": "outbox/other.txt"}
    assert gateway.execute_tool(agent, "write_file", other_path, token, channel="test")["reason"] == "token_action_mismatch"
    assert not (container.sandbox / "outbox" / "other.txt").exists()


def test_token_cannot_be_used_by_another_agent(container, gateway, agent, other_agent):
    request_id = gateway.execute_tool(agent, "write_file", OUTBOX_ARGS, channel="test")["approval_request_id"]
    token = approve_and_collect(container, agent, request_id)
    result = gateway.execute_tool(other_agent, "write_file", OUTBOX_ARGS, token, channel="test")
    assert result["status"] == "approval_rejected" and result["reason"] == "token_agent_mismatch"
    with pytest.raises(Exception):
        gateway.get_approval(other_agent, request_id)


def test_expired_token_is_rejected(container, gateway, agent):
    request_id = gateway.execute_tool(agent, "write_file", OUTBOX_ARGS, channel="test")["approval_request_id"]
    token = approve_and_collect(container, agent, request_id)
    ttl = container.store.get("approval_ttl_seconds")
    container.approvals.clock = lambda: utcnow() + timedelta(seconds=ttl + 5)
    result = gateway.execute_tool(agent, "write_file", OUTBOX_ARGS, token, channel="test")
    assert result["status"] == "approval_rejected" and result["reason"] == "token_expired"


def test_garbage_token_is_rejected(gateway, agent):
    result = gateway.execute_tool(agent, "write_file", OUTBOX_ARGS, "pv_appr_forged", channel="test")
    assert result["status"] == "approval_rejected" and result["reason"] == "token_invalid"


def test_denied_request_issues_no_token(container, gateway, agent):
    request_id = gateway.execute_tool(agent, "write_file", OUTBOX_ARGS, channel="test")["approval_request_id"]
    gateway.decide_approval(request_id, False, "pytest")
    assert gateway.get_approval(agent, request_id)["approval_token"] is None


# ---- revocation ----------------------------------------------------------------------------
def test_revocation_takes_effect_immediately(container, agent_and_key):
    agent, key = agent_and_key
    request_id = container.gateway.execute_tool(agent, "write_file", OUTBOX_ARGS, channel="test")["approval_request_id"]
    container.agents.set_status(agent.id, "revoked")
    container.approvals.expire_for_agent(agent.id)
    with pytest.raises(ForbiddenError):
        container.agents.authenticate(key)
    assert container.approvals.get(request_id)["status"] == "expired"


def test_rotation_invalidates_old_key(container, agent_and_key):
    agent, old_key = agent_and_key
    _, new_key = container.agents.rotate(agent.id)
    with pytest.raises(AuthenticationError):
        container.agents.authenticate(old_key)
    assert container.agents.authenticate(new_key).id == agent.id


# ---- restoration -------------------------------------------------------------------------------
def test_authorised_restore_with_approval(container, gateway, agent):
    sanitized = gateway.sanitize_text(agent, SAMPLE, "r1", channel="test")
    text, session = sanitized["sanitized_text"], sanitized["redaction_session_id"]
    pending = gateway.restore_text(agent, text, session, channel="test")
    assert pending["status"] == "approval_required" and "restored_text" not in pending
    token = approve_and_collect(container, agent, pending["approval_request_id"])
    restored = gateway.restore_text(agent, text, session, token, channel="test")
    assert restored["status"] == "restored" and restored["restored_text"] == SAMPLE
    assert gateway.restore_text(agent, text, session, token, channel="test")["reason"] == "token_reused"


def test_restore_by_another_agent_is_denied(container, gateway, agent, other_agent):
    sanitized = gateway.sanitize_text(agent, SAMPLE, "r2", channel="test")
    container.policies.create({"name": "open restore", "action": "privacy.restore", "resource": "*",
                               "decision": "allow", "priority": 5000})
    result = gateway.restore_text(other_agent, sanitized["sanitized_text"], sanitized["redaction_session_id"], channel="test")
    assert result["status"] == "denied" and "restored_text" not in result


def test_restore_unknown_session_is_denied(gateway, agent):
    result = gateway.restore_text(agent, "[PERSON_1]", "rs_doesnotexist", channel="test")
    assert result["status"] == "denied"


def test_restore_only_replaces_session_placeholders(container, gateway, agent):
    sanitized = gateway.sanitize_text(agent, SAMPLE, "r3", channel="test")
    container.policies.create({"name": "allow restore for test", "agent_id": agent.id, "action": "privacy.restore",
                               "resource": "*", "decision": "allow", "priority": 5000})
    text = "[PERSON_1] / [PERSON_7] / [EMAIL_1]{'[PERSON_1]': 'evil'}"
    result = gateway.restore_text(agent, text, sanitized["redaction_session_id"], channel="test")
    assert result["restored_text"].startswith(f"{PII['person']} / [PERSON_7] / {PII['email']}")
    assert result["unknown_placeholders"] == 1


def test_restore_deny_policy(container, gateway, agent):
    sanitized = gateway.sanitize_text(agent, SAMPLE, "r4", channel="test")
    container.policies.create({"name": "never restore", "action": "privacy.restore", "resource": "*",
                               "decision": "deny", "priority": 5000})
    result = gateway.restore_text(agent, sanitized["sanitized_text"], sanitized["redaction_session_id"], channel="test")
    assert result["status"] == "denied"


def test_restore_token_bound_to_text(container, gateway, agent):
    sanitized = gateway.sanitize_text(agent, SAMPLE, "r5", channel="test")
    pending = gateway.restore_text(agent, "[EMAIL_1]", sanitized["redaction_session_id"], channel="test")
    token = approve_and_collect(container, agent, pending["approval_request_id"])
    result = gateway.restore_text(agent, sanitized["sanitized_text"], sanitized["redaction_session_id"], token, channel="test")
    assert result["reason"] == "token_action_mismatch"


# ---- audit privacy ---------------------------------------------------------------------------
def test_audit_and_logs_never_contain_sensitive_values(container, gateway, agent, caplog):
    caplog.set_level("DEBUG")
    sanitized = gateway.sanitize_text(agent, SAMPLE, "a1", channel="test")
    gateway.check_permission(agent, "file.read", "sandbox:x", {"note": PII["email"]}, channel="test")
    gateway.execute_tool(agent, "write_file", {"path": "notes/p.txt", "content": SAMPLE}, channel="test")
    gateway.execute_tool(agent, "read_file", {"path": "notes/p.txt"}, channel="test")
    gateway.execute_tool(agent, "transform_text", {"operation": "uppercase", "text": SAMPLE}, channel="test")
    pending = gateway.restore_text(agent, sanitized["sanitized_text"], sanitized["redaction_session_id"], channel="test")
    token = approve_and_collect(container, agent, pending["approval_request_id"])
    gateway.restore_text(agent, sanitized["sanitized_text"], sanitized["redaction_session_id"], token, channel="test")
    try:
        gateway.execute_tool(agent, "read_file", {"path": PII["email"], "extra": PII["person"]}, channel="test")
    except ValidationFailed:
        pass

    events = container.audit.search(limit=200)["items"]
    assert len(events) >= 8
    dump = repr(events)
    raw = b""
    for suffix in ("", "-wal"):
        path = container.settings.main_db_path.with_name(container.settings.main_db_path.name + suffix)
        if path.exists():
            raw += path.read_bytes()
    for value in (PII["person"], PII["amount"], "John", "Okafor", token):
        assert value not in dump
        assert value.encode() not in raw
        assert value not in caplog.text
    # The invalid read used the email as a path, but validation failed before a resource was built.
    assert PII["email"] not in dump and PII["email"].encode() not in raw


def test_check_permission_records_decision_only(container, gateway, agent):
    result = gateway.check_permission(agent, "file.write", "sandbox:outbox/x", channel="test")
    assert result["decision"] == "approval_required"
    event = container.audit.get(result["decision_id"])
    assert event["outcome"] == "decision_only" and event["executed"] is False


def test_records_persist_across_restart(settings, container, gateway, agent):
    gateway.sanitize_text(agent, SAMPLE, "p1", channel="test")
    container.policies.create({"name": "persist me", "action": "file.read", "resource": "sandbox:x", "decision": "deny"})
    from privara.core import build

    reopened = build(settings)
    assert reopened.audit.search()["total"] >= 1
    assert any(p["name"] == "persist me" for p in reopened.policies.list())
    assert reopened.agents.get(agent.id)["name"] == "test-agent"
