"""Policy storage, validation and evaluation.

Evaluation order (first match wins):

1. Higher ``priority`` first.
2. Agent-specific rules before ``*`` (any-agent) rules.
3. Exact action before wildcard action.
4. More restrictive decision first (deny > approval_required > allow).

If nothing matches, the configured default decision applies (``deny`` out of the box).
Patterns use shell-style globbing where ``*`` matches any characters, including ``/``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from fnmatch import fnmatchcase
from typing import Any

from ..db import Database, iso
from ..errors import NotFoundError, ValidationFailed
from ..security import new_id

DECISIONS = ("allow", "deny", "approval_required")
RESTRICTIVENESS = {"deny": 2, "approval_required": 1, "allow": 0}
KNOWN_ACTIONS = {
    "file.read": "Read a file through the read_file tool",
    "file.write": "Write a file through the write_file tool",
    "text.transform": "Run the transform_text tool",
    "privacy.sanitize": "Sanitize text through the gateway",
    "privacy.restore": "Restore original values for a redaction session",
    "tool.unregistered": "Attempt to call a tool that is not registered",
}
RESOURCE_SCHEMES = ("sandbox:", "outside:", "session:", "builtin:", "tool:", "text:", "custom:")
_ACTION_RE = re.compile(r"^[a-z*][a-z0-9_.*-]{0,63}$")
_RESOURCE_RE = re.compile(r"^[\x21-\x7e][\x20-\x7e]{0,255}$")


@dataclass
class Decision:
    decision: str
    policy: dict[str, Any] | None
    explanation: str
    default_applied: bool = False

    def policy_ref(self) -> dict[str, Any] | None:
        if not self.policy:
            return None
        keys = ("id", "name", "agent_id", "action", "resource", "decision", "priority")
        return {k: self.policy[k] for k in keys}


SEED_POLICIES: list[dict[str, Any]] = [
    {
        "id": "pol_seed_unregistered",
        "name": "Unregistered tools are denied",
        "description": "Only tools compiled into the gateway's registry can run. Agents cannot register code.",
        "action": "tool.unregistered",
        "resource": "*",
        "decision": "deny",
        "priority": 1000,
    },
    {
        "id": "pol_seed_outside_read",
        "name": "Reading outside the sandbox is denied",
        "description": "Any path that resolves outside the sandbox directory is refused.",
        "action": "file.read",
        "resource": "outside:*",
        "decision": "deny",
        "priority": 900,
    },
    {
        "id": "pol_seed_outside_write",
        "name": "Writing outside the sandbox is denied",
        "description": "Any path that resolves outside the sandbox directory is refused.",
        "action": "file.write",
        "resource": "outside:*",
        "decision": "deny",
        "priority": 900,
    },
    {
        "id": "pol_seed_protected_write",
        "name": "Writing to protected locations is denied",
        "description": "The sandbox's protected/ folder is read-only for agents.",
        "action": "file.write",
        "resource": "sandbox:protected/*",
        "decision": "deny",
        "priority": 500,
    },
    {
        "id": "pol_seed_outbox_write",
        "name": "Writing to the outbox requires approval",
        "description": "Files in outbox/ are meant to leave the machine, so a human approves each write.",
        "action": "file.write",
        "resource": "sandbox:outbox/*",
        "decision": "approval_required",
        "priority": 400,
    },
    {
        "id": "pol_seed_restore",
        "name": "Restoring sensitive values requires approval",
        "description": "Re-identifying redacted values needs a one-time approval token.",
        "action": "privacy.restore",
        "resource": "*",
        "decision": "approval_required",
        "priority": 100,
    },
    {
        "id": "pol_seed_sandbox_read",
        "name": "Reading inside the sandbox is allowed",
        "description": "Agents may read files inside the sandbox directory.",
        "action": "file.read",
        "resource": "sandbox:*",
        "decision": "allow",
        "priority": 100,
    },
    {
        "id": "pol_seed_sandbox_write",
        "name": "Writing inside the sandbox is allowed",
        "description": "Agents may create and update files inside the sandbox directory.",
        "action": "file.write",
        "resource": "sandbox:*",
        "decision": "allow",
        "priority": 100,
    },
    {
        "id": "pol_seed_transform",
        "name": "Text transforms are allowed",
        "description": "The built-in transform_text tool has no side effects.",
        "action": "text.transform",
        "resource": "builtin:*",
        "decision": "allow",
        "priority": 100,
    },
    {
        "id": "pol_seed_sanitize",
        "name": "Sanitizing text is allowed",
        "description": "Any active agent may ask the gateway to redact text.",
        "action": "privacy.sanitize",
        "resource": "*",
        "decision": "allow",
        "priority": 100,
    },
]


def _sort_key(policy: dict[str, Any], agent_id: str) -> tuple:
    return (
        -int(policy["priority"]),
        0 if policy["agent_id"] == agent_id else 1,
        1 if any(ch in policy["action"] for ch in "*?[") else 0,
        -RESTRICTIVENESS[policy["decision"]],
        policy["created_at"],
    )


class PolicyEngine:
    def __init__(self, db: Database, default_decision_fn):
        self.db = db
        self._default_decision = default_decision_fn

    # ---- storage ---------------------------------------------------------------------------
    def seed(self, *, reset: bool = False) -> None:
        """Insert missing built-in policies. With ``reset``, also delete user-created policies and
        restore built-in policies to their original settings."""
        now = iso()
        with self.db.transaction() as conn:
            if reset:
                conn.execute("DELETE FROM policies")
            for policy in SEED_POLICIES:
                conn.execute(
                    "INSERT OR IGNORE INTO policies (id, name, description, agent_id, action, resource, decision,"
                    " priority, enabled, origin, created_at, updated_at)"
                    " VALUES (?, ?, ?, '*', ?, ?, ?, ?, 1, 'seed', ?, ?)",
                    (
                        policy["id"], policy["name"], policy["description"], policy["action"],
                        policy["resource"], policy["decision"], policy["priority"], now, now,
                    ),
                )

    def list(self) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM policies ORDER BY priority DESC, created_at")
        for row in rows:
            row["enabled"] = bool(row["enabled"])
        return rows

    def get(self, policy_id: str) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM policies WHERE id = ?", (policy_id,))
        if not row:
            raise NotFoundError("Policy not found.")
        row["enabled"] = bool(row["enabled"])
        return row

    def validate(self, data: dict[str, Any]) -> dict[str, Any]:
        problems: list[dict[str, str]] = []
        name = (data.get("name") or "").strip()
        if not name or len(name) > 120:
            problems.append({"field": "name", "message": "Name is required (max 120 characters)."})
        action = (data.get("action") or "").strip()
        if not _ACTION_RE.match(action):
            problems.append({"field": "action", "message": "Action must look like 'file.read' or 'file.*'."})
        elif not any(ch in action for ch in "*?[") and action not in KNOWN_ACTIONS:
            problems.append({"field": "action", "message": "Unknown action. Use a known action or a wildcard."})
        resource = (data.get("resource") or "").strip()
        if not _RESOURCE_RE.match(resource):
            problems.append({"field": "resource", "message": "Resource scope must be printable text (max 256)."})
        elif resource != "*" and not resource.startswith(RESOURCE_SCHEMES):
            problems.append(
                {"field": "resource", "message": "Resource must be '*' or start with " + ", ".join(RESOURCE_SCHEMES)}
            )
        if data.get("decision") not in DECISIONS:
            problems.append({"field": "decision", "message": "Decision must be allow, deny or approval_required."})
        agent_id = (data.get("agent_id") or "*").strip()
        if agent_id != "*" and not self.db.query_one("SELECT id FROM agents WHERE id = ?", (agent_id,)):
            problems.append({"field": "agent_id", "message": "Agent does not exist."})
        try:
            priority = int(data.get("priority", 100))
            if not 0 <= priority <= 10_000:
                raise ValueError
        except (TypeError, ValueError):
            problems.append({"field": "priority", "message": "Priority must be an integer between 0 and 10000."})
            priority = 100
        if problems:
            raise ValidationFailed("Policy is invalid.", details=problems)
        return {
            "name": name,
            "description": (data.get("description") or "").strip()[:500],
            "agent_id": agent_id,
            "action": action,
            "resource": resource,
            "decision": data["decision"],
            "priority": priority,
            "enabled": bool(data.get("enabled", True)),
        }

    def create(self, data: dict[str, Any]) -> dict[str, Any]:
        clean = self.validate(data)
        policy_id = new_id("pol")
        now = iso()
        self.db.execute(
            "INSERT INTO policies (id, name, description, agent_id, action, resource, decision, priority, enabled,"
            " origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)",
            (
                policy_id, clean["name"], clean["description"], clean["agent_id"], clean["action"],
                clean["resource"], clean["decision"], clean["priority"], int(clean["enabled"]), now, now,
            ),
        )
        return self.get(policy_id)

    def update(self, policy_id: str, data: dict[str, Any]) -> dict[str, Any]:
        current = self.get(policy_id)
        merged = {**current, **{k: v for k, v in data.items() if v is not None}}
        clean = self.validate(merged)
        self.db.execute(
            "UPDATE policies SET name=?, description=?, agent_id=?, action=?, resource=?, decision=?, priority=?,"
            " enabled=?, updated_at=? WHERE id=?",
            (
                clean["name"], clean["description"], clean["agent_id"], clean["action"], clean["resource"],
                clean["decision"], clean["priority"], int(clean["enabled"]), iso(), policy_id,
            ),
        )
        return self.get(policy_id)

    def delete(self, policy_id: str) -> None:
        policy = self.get(policy_id)
        if policy["origin"] == "seed":
            raise ValidationFailed("Built-in policies cannot be deleted; disable them instead.", code="seed_policy")
        self.db.execute("DELETE FROM policies WHERE id = ?", (policy_id,))

    # ---- evaluation ------------------------------------------------------------------------
    def matching(self, agent_id: str, action: str, resource: str) -> list[dict[str, Any]]:
        rows = self.db.query(
            "SELECT * FROM policies WHERE enabled = 1 AND agent_id IN ('*', ?)", (agent_id,)
        )
        matches = [
            row
            for row in rows
            if fnmatchcase(action, row["action"]) and fnmatchcase(resource, row["resource"])
        ]
        return sorted(matches, key=lambda p: _sort_key(p, agent_id))

    def evaluate(self, agent_id: str, action: str, resource: str) -> Decision:
        matches = self.matching(agent_id, action, resource)
        if matches:
            winner = matches[0]
            scope = "this agent" if winner["agent_id"] == agent_id and agent_id != "*" else "all agents"
            verb = {"allow": "allows", "deny": "denies", "approval_required": "requires approval for"}[
                winner["decision"]
            ]
            explanation = (
                f"Policy “{winner['name']}” (priority {winner['priority']}, applies to {scope}) {verb} "
                f"action '{action}' on resource matching '{winner['resource']}'."
            )
            if len(matches) > 1:
                explanation += f" {len(matches) - 1} lower-precedence polic{'y' if len(matches) == 2 else 'ies'} also matched."
            return Decision(winner["decision"], winner, explanation)
        default = self._default_decision()
        explanation = (
            f"No enabled policy matches action '{action}' on this resource, so the default decision "
            f"'{default}' applies."
        )
        return Decision(default, None, explanation, default_applied=True)

    def effective_for_agent(self, agent_id: str) -> list[dict[str, Any]]:
        rows = self.db.query(
            "SELECT * FROM policies WHERE agent_id IN ('*', ?) ORDER BY priority DESC, created_at", (agent_id,)
        )
        rows.sort(key=lambda p: _sort_key(p, agent_id))
        for row in rows:
            row["enabled"] = bool(row["enabled"])
            row["scope"] = "agent" if row["agent_id"] == agent_id else "global"
        return rows
