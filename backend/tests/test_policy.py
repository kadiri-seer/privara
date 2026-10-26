import pytest

from privara.errors import ValidationFailed


@pytest.mark.parametrize(
    ("action", "resource", "expected", "policy_id"),
    [
        ("file.read", "sandbox:notes/welcome.txt", "allow", "pol_seed_sandbox_read"),
        ("file.read", "outside:../etc/passwd", "deny", "pol_seed_outside_read"),
        ("file.write", "sandbox:notes/new.txt", "allow", "pol_seed_sandbox_write"),
        ("file.write", "sandbox:protected/policy-notice.txt", "deny", "pol_seed_protected_write"),
        ("file.write", "outside:/tmp/x", "deny", "pol_seed_outside_write"),
        ("file.write", "sandbox:outbox/a.txt", "approval_required", "pol_seed_outbox_write"),
        ("privacy.restore", "session:rs_123", "approval_required", "pol_seed_restore"),
        ("tool.unregistered", "tool:run_shell", "deny", "pol_seed_unregistered"),
    ],
)
def test_seeded_policies(container, agent, action, resource, expected, policy_id):
    decision = container.policies.evaluate(agent.id, action, resource)
    assert decision.decision == expected
    assert decision.policy["id"] == policy_id


def test_default_deny_when_nothing_matches(container, agent):
    decision = container.policies.evaluate(agent.id, "custom.action", "custom:thing")
    assert decision.decision == "deny" and decision.default_applied and decision.policy is None


def test_default_decision_is_configurable(container, agent):
    container.store.update({"default_decision": "approval_required"})
    assert container.policies.evaluate(agent.id, "custom.action", "custom:x").decision == "approval_required"
    with pytest.raises(ValidationFailed):
        container.store.update({"default_decision": "allow"})  # allow-by-default is not offered


def test_agent_specific_rule_takes_precedence(container, agent, other_agent):
    container.policies.create({
        "name": "test-agent may not read notes", "agent_id": agent.id, "action": "file.read",
        "resource": "sandbox:notes/*", "decision": "deny", "priority": 100,
    })
    assert container.policies.evaluate(agent.id, "file.read", "sandbox:notes/a.txt").decision == "deny"
    assert container.policies.evaluate(other_agent.id, "file.read", "sandbox:notes/a.txt").decision == "allow"


def test_restrictive_wins_on_tie(container, agent):
    container.policies.create({
        "name": "tie deny", "action": "file.read", "resource": "sandbox:*", "decision": "deny", "priority": 100,
    })
    assert container.policies.evaluate(agent.id, "file.read", "sandbox:x").decision == "deny"


def test_disabled_policy_is_ignored(container, agent):
    container.policies.update("pol_seed_sandbox_read", {"enabled": False})
    decision = container.policies.evaluate(agent.id, "file.read", "sandbox:notes/welcome.txt")
    assert decision.decision == "deny" and decision.default_applied


@pytest.mark.parametrize(
    "bad",
    [
        {"name": "", "action": "file.read", "resource": "*", "decision": "allow"},
        {"name": "x", "action": "FILE READ", "resource": "*", "decision": "allow"},
        {"name": "x", "action": "made.up", "resource": "*", "decision": "allow"},
        {"name": "x", "action": "file.read", "resource": "/etc/*", "decision": "allow"},
        {"name": "x", "action": "file.read", "resource": "*", "decision": "maybe"},
        {"name": "x", "action": "file.read", "resource": "*", "decision": "allow", "agent_id": "agt_nope"},
        {"name": "x", "action": "file.read", "resource": "*", "decision": "allow", "priority": 99999},
    ],
)
def test_invalid_policies_are_rejected(container, bad):
    with pytest.raises(ValidationFailed):
        container.policies.create(bad)


def test_seed_policies_cannot_be_deleted(container):
    with pytest.raises(ValidationFailed):
        container.policies.delete("pol_seed_restore")


def test_reset_restores_seeds_and_removes_user_policies(container):
    container.policies.create({"name": "mine", "action": "file.*", "resource": "*", "decision": "deny"})
    container.policies.update("pol_seed_sandbox_read", {"decision": "deny"})
    container.policies.seed(reset=True)
    policies = container.policies.list()
    assert all(p["origin"] == "seed" for p in policies)
    assert container.policies.get("pol_seed_sandbox_read")["decision"] == "allow"
