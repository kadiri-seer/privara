"""The gateway: the one code path every client (MCP, REST, Privacy Lab, demo) goes through.

Each public method takes an authenticated :class:`~privara.auth.Agent`, performs policy
evaluation, enforces approvals, executes, and writes exactly one audit event.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from .approvals import ApprovalRejected, Approvals, binding_hash
from .audit import AuditLog
from .auth import Agent, AgentStore
from .db import Database, iso
from .errors import NotFoundError, ValidationFailed
from .policy.engine import PolicyEngine
from .privacy.engine import PrivacyEngine, SanitizeOutcome, SensitivityConfig
from .security import new_id
from .settings_store import SettingsStore
from .tools.registry import TOOLS, ToolContext, ToolExecutionError, validate_args

_ACTION_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
_RESOURCE_RE = re.compile(r"^[\x20-\x7e]{1,256}$")
_SESSION_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


class Gateway:
    def __init__(
        self,
        *,
        main_db: Database,
        agents: AgentStore,
        policies: PolicyEngine,
        approvals: Approvals,
        audit: AuditLog,
        privacy: PrivacyEngine,
        settings: SettingsStore,
        tool_context: ToolContext,
        max_text_chars: int,
    ):
        self.db = main_db
        self.agents = agents
        self.policies = policies
        self.approvals = approvals
        self.audit = audit
        self.privacy = privacy
        self.settings = settings
        self.tool_context = tool_context
        self.max_text_chars = max_text_chars

    # ---- helpers -----------------------------------------------------------------------------
    def _check_text(self, text: str, field: str = "text") -> None:
        if not isinstance(text, str):
            raise ValidationFailed(f"'{field}' must be a string.")
        if len(text) > self.max_text_chars:
            raise ValidationFailed(
                f"'{field}' exceeds the maximum of {self.max_text_chars} characters.", code="text_too_long"
            )

    def _session(self, agent: Agent, client_session_id: str) -> str:
        if not _SESSION_RE.match(client_session_id or ""):
            raise ValidationFailed("session_id must be 1–64 characters of letters, digits, '.', '_', ':' or '-'.")
        row = self.db.query_one(
            "SELECT id FROM redaction_sessions WHERE agent_id = ? AND client_session_id = ?",
            (agent.id, client_session_id),
        )
        now = iso()
        if row:
            self.db.execute("UPDATE redaction_sessions SET last_used_at = ? WHERE id = ?", (now, row["id"]))
            return row["id"]
        session_id = new_id("rs")
        self.db.execute(
            "INSERT OR IGNORE INTO redaction_sessions (id, agent_id, client_session_id, created_at, last_used_at, is_demo)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, agent.id, client_session_id, now, now, int(agent.is_demo)),
        )
        row = self.db.query_one(
            "SELECT id FROM redaction_sessions WHERE agent_id = ? AND client_session_id = ?",
            (agent.id, client_session_id),
        )
        return row["id"]

    def sensitivity(self, raw: dict[str, Any] | None) -> SensitivityConfig:
        raw = raw or {}
        categories = raw.get("categories")
        if categories is not None and not (isinstance(categories, list) and all(isinstance(c, str) for c in categories)):
            raise ValidationFailed("sensitivity.categories must be a list of category names.")
        level = raw.get("level")
        if level is not None and level not in ("low", "medium", "high"):
            raise ValidationFailed("sensitivity.level must be low, medium or high.")
        threshold = raw.get("threshold")
        if threshold is not None and not isinstance(threshold, (int, float)):
            raise ValidationFailed("sensitivity.threshold must be a number between 0 and 1.")
        defaults = self.settings.get("default_categories")
        default_level = self.settings.get("detection_level")
        return SensitivityConfig.build(
            categories=categories,
            level=level or default_level,
            threshold=threshold,
            defaults=defaults,
            default_threshold=0.4,
        )

    def _do_sanitize(self, agent: Agent, text: str, client_session_id: str, config: SensitivityConfig) -> tuple[str, SanitizeOutcome]:
        redaction_session_id = self._session(agent, client_session_id)
        outcome = self.privacy.sanitize(text, redaction_session_id, config)
        return redaction_session_id, outcome

    @staticmethod
    def _placeholder_list(outcome: SanitizeOutcome) -> list[dict[str, str]]:
        seen: dict[str, str] = {}
        for entity in outcome.entities:
            seen.setdefault(entity.placeholder, entity.category)
        return [{"placeholder": p, "category": c} for p, c in seen.items()]

    # ---- sanitize_text ---------------------------------------------------------------------
    def sanitize_text(
        self,
        agent: Agent,
        text: str,
        session_id: str = "default",
        sensitivity: dict[str, Any] | None = None,
        *,
        channel: str,
        include_spans: bool = False,
    ) -> dict[str, Any]:
        self._check_text(text)
        config = self.sensitivity(sensitivity)
        decision = self.policies.evaluate(agent.id, "privacy.sanitize", "text:inline")
        if decision.decision != "allow":
            event_id = self.audit.record(
                agent_id=agent.id, agent_name=agent.name, channel=channel, action="privacy.sanitize",
                resource="text:inline", decision=decision.decision, policy=decision.policy,
                explanation=decision.explanation, outcome="blocked", is_demo=agent.is_demo,
                details={"text_length": len(text), "default_applied": decision.default_applied},
            )
            return {
                "status": "denied", "decision": decision.decision, "explanation": decision.explanation,
                "policy": decision.policy_ref(), "decision_id": event_id,
            }
        redaction_session_id, outcome = self._do_sanitize(agent, text, session_id, config)
        event_id = self.audit.record(
            agent_id=agent.id, agent_name=agent.name, channel=channel, action="privacy.sanitize",
            resource="text:inline", decision="allow", policy=decision.policy,
            explanation=f"Sanitized {outcome.redaction_count} value(s). {decision.explanation}",
            outcome="sanitized", redaction_count=outcome.redaction_count,
            entity_categories=outcome.categories, redaction_session_id=redaction_session_id,
            is_demo=agent.is_demo,
            details={"text_length": len(text), "detector_mode": self.privacy.detector.mode},
        )
        result: dict[str, Any] = {
            "status": "sanitized",
            "sanitized_text": outcome.sanitized_text,
            "redaction_session_id": redaction_session_id,
            "session_id": session_id,
            "entity_categories": outcome.categories,
            "category_counts": outcome.category_counts(),
            "redaction_count": outcome.redaction_count,
            "placeholders": self._placeholder_list(outcome),
            "decision_id": event_id,
            "detector": self.privacy.detector.describe(),
            "threshold": config.threshold,
        }
        if include_spans:
            result["entities"] = [
                {k: v for k, v in span.items() if k != "detector"} for span in outcome.spans()
            ]
        return result

    # ---- check_permission ------------------------------------------------------------------
    def check_permission(
        self,
        agent: Agent,
        action: str,
        resource: str,
        context: dict[str, Any] | None = None,
        *,
        channel: str,
    ) -> dict[str, Any]:
        if not _ACTION_RE.match(action or ""):
            raise ValidationFailed("action must look like 'file.read' (lowercase, dot-separated).")
        if not _RESOURCE_RE.match(resource or ""):
            raise ValidationFailed("resource must be 1–256 printable ASCII characters.")
        if context is not None and not isinstance(context, dict):
            raise ValidationFailed("context must be an object.")
        decision = self.policies.evaluate(agent.id, action, resource)
        matched = len(self.policies.matching(agent.id, action, resource))
        event_id = self.audit.record(
            agent_id=agent.id, agent_name=agent.name, channel=channel, action=action, resource=resource,
            decision=decision.decision, policy=decision.policy, explanation=decision.explanation,
            outcome="decision_only", is_demo=agent.is_demo,
            details={
                "context_keys": sorted(list((context or {}).keys()))[:20],
                "default_applied": decision.default_applied,
                "matched_policies": matched,
            },
        )
        return {
            "decision": decision.decision,
            "policy": decision.policy_ref(),
            "explanation": decision.explanation,
            "decision_id": event_id,
            "default_applied": decision.default_applied,
            "evaluated_at": iso(),
            "note": "This is a decision only. Nothing was executed.",
        }

    # ---- execute_tool ----------------------------------------------------------------------
    def execute_tool(
        self,
        agent: Agent,
        tool_name: str,
        arguments: dict[str, Any] | None,
        approval_token: str | None = None,
        *,
        channel: str,
        session_id: str = "default",
        sanitize_output: bool = True,
    ) -> dict[str, Any]:
        base = {"agent_id": agent.id, "agent_name": agent.name, "channel": channel, "is_demo": agent.is_demo}
        tool = TOOLS.get(tool_name if isinstance(tool_name, str) else "")
        safe_tool_name = tool_name[:64] if isinstance(tool_name, str) else "?"
        if tool is None:
            decision = self.policies.evaluate(agent.id, "tool.unregistered", f"tool:{safe_tool_name}")
            explanation = (
                f"Tool '{safe_tool_name}' is not in the gateway's registry, so it cannot run. "
                "The registry is fixed in code; agents cannot register tools."
            )
            if decision.policy:
                explanation += f" Matching policy: “{decision.policy['name']}”."
            event_id = self.audit.record(
                **base, action="tool.unregistered", tool_name=safe_tool_name, resource=f"tool:{safe_tool_name}",
                decision="deny", policy=decision.policy, explanation=explanation, outcome="rejected",
                details={"tool_registered": False},
            )
            return {"status": "denied", "decision": "deny", "explanation": explanation,
                    "policy": decision.policy_ref(), "decision_id": event_id}

        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            raise ValidationFailed("arguments must be a JSON object.")
        try:
            args = validate_args(tool, arguments)
        except ValidationFailed as exc:
            self.audit.record(
                **base, action=tool.action, tool_name=tool.name, resource=None, decision="deny",
                explanation="Arguments failed schema validation; nothing was evaluated or executed.",
                outcome="rejected", details={"argument_fields": sorted(arguments.keys())[:20], "error_code": exc.code},
            )
            raise

        resource = tool.resource(args, self.tool_context)
        decision = self.policies.evaluate(agent.id, tool.action, resource)
        canonical_args = args.model_dump(mode="json")
        binding = binding_hash(agent.id, tool.action, tool.name, resource, canonical_args)
        details = {
            "argument_fields": sorted(canonical_args.keys()),
            "default_applied": decision.default_applied,
            "sanitize_output": sanitize_output,
        }
        if "content" in canonical_args:
            details["content_length"] = len(canonical_args["content"])
        if "text" in canonical_args:
            details["text_length"] = len(canonical_args["text"])
        if "mode" in canonical_args:
            details["mode"] = canonical_args["mode"]
        if "operation" in canonical_args:
            details["operation"] = canonical_args["operation"]
        common = {
            "decision": decision.decision,
            "policy": decision.policy_ref(),
            "explanation": decision.explanation,
            "resource": resource,
            "tool_name": tool.name,
        }

        if decision.decision == "deny":
            event_id = self.audit.record(
                **base, action=tool.action, tool_name=tool.name, resource=resource, decision="deny",
                policy=decision.policy, explanation=decision.explanation, outcome="blocked", details=details,
            )
            return {"status": "denied", **common, "decision_id": event_id}

        approval_record = None
        if decision.decision == "approval_required":
            if not approval_token:
                request = self.approvals.create(
                    agent_id=agent.id, action=tool.action, resource=resource, tool_name=tool.name, binding=binding,
                    summary={k: v for k, v in details.items() if k in ("argument_fields", "content_length", "mode", "operation", "text_length")},
                    policy_id=decision.policy["id"] if decision.policy else None, is_demo=agent.is_demo,
                )
                event_id = self.audit.record(
                    **base, action=tool.action, tool_name=tool.name, resource=resource,
                    decision="approval_required", policy=decision.policy, explanation=decision.explanation,
                    outcome="pending_approval", approval_status="pending", approval_request_id=request["id"],
                    details=details,
                )
                return {
                    "status": "approval_required", **common, "decision_id": event_id,
                    "approval_request_id": request["id"],
                    "next_step": "A human must approve this request. Then collect the one-time token with "
                    "get_approval and call execute_tool again with identical arguments and approval_token.",
                }
            try:
                approval_record = self.approvals.consume(agent.id, approval_token, binding)
            except ApprovalRejected as exc:
                event_id = self.audit.record(
                    **base, action=tool.action, tool_name=tool.name, resource=resource,
                    decision="approval_required", policy=decision.policy,
                    explanation=f"{exc.message} {decision.explanation}", outcome="approval_rejected",
                    approval_status="rejected", details={**details, "approval_reason": exc.code},
                )
                return {"status": "approval_rejected", **common, "reason": exc.code, "message": exc.message,
                        "decision_id": event_id}

        # Allowed (by policy, or by a valid approval token): execute.
        approval_kwargs = {}
        if approval_record:
            approval_kwargs = {"approval_status": "approved", "approval_request_id": approval_record["id"]}
        explanation = decision.explanation
        if approval_record:
            explanation = f"Executed with approval {approval_record['id']} (one-time token consumed). " + explanation
        try:
            result = tool.run(args, self.tool_context)
        except ToolExecutionError as exc:
            event_id = self.audit.record(
                **base, action=tool.action, tool_name=tool.name, resource=resource, decision=decision.decision,
                policy=decision.policy, explanation=f"{explanation} Tool refused: {exc.message}", outcome="failed",
                details={**details, "error_code": exc.code}, **approval_kwargs,
            )
            return {"status": "failed", **common, "error": {"code": exc.code, "message": exc.message},
                    "decision_id": event_id}

        redaction_count = 0
        categories: list[str] = []
        redaction_session_id = None
        if sanitize_output and tool.sanitizable_output and isinstance(result.get(tool.sanitizable_output), str):
            config = self.sensitivity(None)
            redaction_session_id, outcome = self._do_sanitize(agent, result[tool.sanitizable_output], session_id, config)
            result[tool.sanitizable_output] = outcome.sanitized_text
            result["sanitized"] = True
            result["redaction_session_id"] = redaction_session_id
            result["redaction_count"] = outcome.redaction_count
            result["entity_categories"] = outcome.categories
            redaction_count, categories = outcome.redaction_count, outcome.categories
        if "bytes" in result:
            details["bytes"] = result["bytes"]

        event_id = self.audit.record(
            **base, action=tool.action, tool_name=tool.name, resource=resource, decision=decision.decision,
            policy=decision.policy, explanation=explanation, outcome="executed", details=details,
            redaction_count=redaction_count, entity_categories=categories, redaction_session_id=redaction_session_id,
            **approval_kwargs,
        )
        return {"status": "executed", **common, "result": result, "decision_id": event_id,
                **({"approval_request_id": approval_record["id"]} if approval_record else {})}

    # ---- restore_text ----------------------------------------------------------------------
    def restore_text(
        self,
        agent: Agent,
        text: str,
        redaction_session_id: str,
        approval_token: str | None = None,
        *,
        channel: str,
    ) -> dict[str, Any]:
        self._check_text(text)
        base = {"agent_id": agent.id, "agent_name": agent.name, "channel": channel, "is_demo": agent.is_demo}
        resource = f"session:{redaction_session_id[:64] if isinstance(redaction_session_id, str) else '?'}"
        session = None
        if isinstance(redaction_session_id, str) and _SESSION_RE.match(redaction_session_id):
            session = self.db.query_one("SELECT * FROM redaction_sessions WHERE id = ?", (redaction_session_id,))
        if session is None or session["agent_id"] != agent.id:
            # Same response for "does not exist" and "belongs to another agent" to avoid enumeration.
            reason = "Redaction session does not exist or does not belong to the requesting agent."
            event_id = self.audit.record(
                **base, action="privacy.restore", resource=resource, decision="deny", explanation=reason,
                outcome="blocked", details={"text_length": len(text)},
            )
            return {"status": "denied", "decision": "deny", "explanation": reason, "decision_id": event_id,
                    "policy": None}

        decision = self.policies.evaluate(agent.id, "privacy.restore", resource)
        text_digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        binding = binding_hash(agent.id, "privacy.restore", None, resource, {"text_sha256": text_digest})
        common = {"decision": decision.decision, "policy": decision.policy_ref(), "explanation": decision.explanation}
        details = {"text_length": len(text), "default_applied": decision.default_applied}

        if decision.decision == "deny":
            event_id = self.audit.record(
                **base, action="privacy.restore", resource=resource, decision="deny", policy=decision.policy,
                explanation=decision.explanation, outcome="blocked", details=details,
            )
            return {"status": "denied", **common, "decision_id": event_id}

        approval_record = None
        if decision.decision == "approval_required":
            if not approval_token:
                request = self.approvals.create(
                    agent_id=agent.id, action="privacy.restore", resource=resource, tool_name=None, binding=binding,
                    summary={"text_length": len(text)}, policy_id=decision.policy["id"] if decision.policy else None,
                    is_demo=agent.is_demo,
                )
                event_id = self.audit.record(
                    **base, action="privacy.restore", resource=resource, decision="approval_required",
                    policy=decision.policy, explanation=decision.explanation, outcome="pending_approval",
                    approval_status="pending", approval_request_id=request["id"], details=details,
                )
                return {"status": "approval_required", **common, "decision_id": event_id,
                        "approval_request_id": request["id"],
                        "next_step": "After approval, collect the token with get_approval and call restore_text "
                        "again with the identical text and approval_token."}
            try:
                approval_record = self.approvals.consume(agent.id, approval_token, binding)
            except ApprovalRejected as exc:
                event_id = self.audit.record(
                    **base, action="privacy.restore", resource=resource, decision="approval_required",
                    policy=decision.policy, explanation=f"{exc.message} {decision.explanation}",
                    outcome="approval_rejected", approval_status="rejected",
                    details={**details, "approval_reason": exc.code},
                )
                return {"status": "approval_rejected", **common, "reason": exc.code, "message": exc.message,
                        "decision_id": event_id}

        restored_text, restored, unknown = self.privacy.restore(text, redaction_session_id)
        explanation = decision.explanation
        if approval_record:
            explanation = f"Restored with approval {approval_record['id']} (one-time token consumed). " + explanation
        event_id = self.audit.record(
            **base, action="privacy.restore", resource=resource, decision=decision.decision, policy=decision.policy,
            explanation=explanation, outcome="restored", redaction_session_id=redaction_session_id,
            details={**details, "restored_count": restored, "unknown_placeholders": unknown},
            **({"approval_status": "approved", "approval_request_id": approval_record["id"]} if approval_record else {}),
        )
        return {"status": "restored", **common, "restored_text": restored_text, "restored_count": restored,
                "unknown_placeholders": unknown, "decision_id": event_id}

    # ---- approvals (agent side) ------------------------------------------------------------
    def get_approval(self, agent: Agent, approval_request_id: str) -> dict[str, Any]:
        if not isinstance(approval_request_id, str) or not _SESSION_RE.match(approval_request_id):
            raise NotFoundError("Approval request not found.")
        return self.approvals.collect(agent.id, approval_request_id)

    # ---- approvals (operator side) ---------------------------------------------------------
    def decide_approval(self, request_id: str, approve: bool, decided_by: str, *, channel: str = "admin") -> dict[str, Any]:
        request = self.approvals.decide(request_id, approve, decided_by)
        agent_row = self.db.query_one("SELECT name FROM agents WHERE id = ?", (request["agent_id"],))
        verb = "approved" if approve else "denied"
        self.audit.record(
            agent_id=request["agent_id"], agent_name=agent_row["name"] if agent_row else None, channel=channel,
            action=f"approval.{'approve' if approve else 'deny'}", tool_name=request["tool_name"],
            resource=request["resource"], decision="allow" if approve else "deny",
            explanation=f"Operator ({decided_by}) {verb} request {request_id} for '{request['action']}'. "
            + ("The agent can now collect a one-time token." if approve else "The action will not run."),
            outcome="decision_only", approval_status=request["status"], approval_request_id=request_id,
            is_demo=request["is_demo"], details={"decided_by": decided_by[:80]},
        )
        return request

    # ---- session admin ---------------------------------------------------------------------
    def session_info(self, redaction_session_id: str) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM redaction_sessions WHERE id = ?", (redaction_session_id,))
        if not row:
            raise NotFoundError("Redaction session not found.")
        row["placeholders"] = self.privacy.vault.placeholders(redaction_session_id)
        row["is_demo"] = bool(row["is_demo"])
        return row

    def clear_session(self, redaction_session_id: str) -> int:
        removed = self.privacy.vault.clear_session(redaction_session_id)
        self.db.execute("DELETE FROM redaction_sessions WHERE id = ?", (redaction_session_id,))
        return removed

    def clear_all_sessions(self) -> int:
        removed = self.privacy.vault.clear_all()
        self.db.execute("DELETE FROM redaction_sessions")
        return removed
