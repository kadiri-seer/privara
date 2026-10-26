"""Append-only activity log.

Only whitelisted, non-sensitive fields are written: identifiers, action names, resource
scopes, decisions, counts and categories. Raw text, tool arguments, file contents, original
values, mappings, tokens and keys are never passed to :meth:`AuditLog.record`.
"""

from __future__ import annotations

import time
from datetime import timedelta
from typing import Any

from .db import Database, dumps, iso, loads, utcnow
from .security import new_id

OUTCOMES = {
    "executed": "The action ran.",
    "failed": "The action was permitted but failed while running.",
    "blocked": "The action was not run because policy denied it.",
    "rejected": "The request was rejected before evaluation (invalid input or unregistered tool).",
    "pending_approval": "The action was not run; it is waiting for human approval.",
    "approval_rejected": "The action was not run because the approval token was invalid.",
    "decision_only": "A permission check only — nothing was executed.",
    "sanitized": "Text was sanitized; nothing was executed.",
    "restored": "Original values were restored for the requesting agent.",
}

_SAFE_DETAIL_KEYS = {
    "argument_fields", "content_length", "text_length", "error_code", "tool_registered", "context_keys",
    "restored_count", "unknown_placeholders", "mode", "operation", "sanitize_output", "approval_reason",
    "decided_by", "default_applied", "matched_policies", "bytes", "detector_mode",
}


class AuditLog:
    def __init__(self, db: Database, retention_days_fn):
        self.db = db
        self._retention_days = retention_days_fn
        self._last_purge = 0.0

    def record(
        self,
        *,
        agent_id: str | None,
        agent_name: str | None,
        channel: str,
        action: str,
        decision: str,
        explanation: str,
        outcome: str,
        tool_name: str | None = None,
        resource: str | None = None,
        policy: dict[str, Any] | None = None,
        approval_status: str | None = None,
        approval_request_id: str | None = None,
        redaction_count: int = 0,
        entity_categories: list[str] | None = None,
        redaction_session_id: str | None = None,
        details: dict[str, Any] | None = None,
        is_demo: bool = False,
        event_id: str | None = None,
    ) -> str:
        if outcome not in OUTCOMES:
            raise ValueError("unknown outcome")
        safe_details = {k: v for k, v in (details or {}).items() if k in _SAFE_DETAIL_KEYS}
        event_id = event_id or new_id("evt")
        self.db.execute(
            "INSERT INTO audit_events (id, ts, agent_id, agent_name, channel, action, tool_name, resource, decision,"
            " policy_id, policy_name, explanation, outcome, approval_status, approval_request_id, redaction_count,"
            " entity_categories, redaction_session_id, details, is_demo)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                event_id, iso(), agent_id, agent_name, channel, action, tool_name, resource, decision,
                policy["id"] if policy else None, policy["name"] if policy else None, explanation, outcome,
                approval_status, approval_request_id, redaction_count, dumps(sorted(entity_categories or [])),
                redaction_session_id, dumps(safe_details), int(is_demo),
            ),
        )
        self.maybe_purge()
        return event_id

    def _row(self, row: dict[str, Any]) -> dict[str, Any]:
        row["entity_categories"] = loads(row["entity_categories"], [])
        row["details"] = loads(row["details"], {})
        row["is_demo"] = bool(row["is_demo"])
        row["outcome_description"] = OUTCOMES.get(row["outcome"], "")
        row["executed"] = row["outcome"] in ("executed", "failed", "restored")
        return row

    def search(
        self,
        *,
        agent_id: str | None = None,
        action: str | None = None,
        decision: str | None = None,
        outcome: str | None = None,
        since: str | None = None,
        until: str | None = None,
        q: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any]:
        where: list[str] = []
        params: list[Any] = []
        if agent_id:
            where.append("agent_id = ?")
            params.append(agent_id)
        if action:
            where.append("action = ?")
            params.append(action)
        if decision:
            where.append("decision = ?")
            params.append(decision)
        if outcome:
            where.append("outcome = ?")
            params.append(outcome)
        if since:
            where.append("ts >= ?")
            params.append(since)
        if until:
            where.append("ts <= ?")
            params.append(until)
        if q:
            where.append(
                "(agent_name LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR resource LIKE ? ESCAPE '\\'"
                " OR tool_name LIKE ? ESCAPE '\\' OR explanation LIKE ? ESCAPE '\\' OR id = ?)"
            )
            like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            params.extend([like, like, like, like, like, q])
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        total = self.db.query_one(f"SELECT COUNT(*) AS n FROM audit_events{clause}", tuple(params))["n"]
        rows = self.db.query(
            f"SELECT * FROM audit_events{clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?",
            tuple(params + [max(1, min(limit, 200)), max(0, offset)]),
        )
        return {"total": total, "items": [self._row(r) for r in rows]}

    def get(self, event_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM audit_events WHERE id = ?", (event_id,))
        return self._row(row) if row else None

    def stats(self) -> dict[str, int]:
        row = self.db.query_one(
            "SELECT COALESCE(SUM(redaction_count), 0) AS redactions,"
            " COALESCE(SUM(CASE WHEN decision = 'allow' AND action != 'privacy.sanitize' AND outcome != 'decision_only' THEN 1 ELSE 0 END), 0) AS allowed,"
            " COALESCE(SUM(CASE WHEN decision = 'deny' AND outcome != 'decision_only' THEN 1 ELSE 0 END), 0) AS blocked,"
            " COUNT(*) AS events FROM audit_events"
        )
        return {k: int(v) for k, v in (row or {}).items()}

    def distinct_actions(self) -> list[str]:
        return [r["action"] for r in self.db.query("SELECT DISTINCT action FROM audit_events ORDER BY action")]

    def purge(self, days: int | None = None) -> int:
        days = self._retention_days() if days is None else days
        if not days or days <= 0:
            return 0
        cutoff = iso(utcnow() - timedelta(days=days))
        removed = self.db.execute("DELETE FROM audit_events WHERE ts < ?", (cutoff,))
        self.db.execute(
            "DELETE FROM approval_requests WHERE status IN ('consumed','expired','denied') AND created_at < ?",
            (cutoff,),
        )
        return removed

    def maybe_purge(self) -> None:
        now = time.monotonic()
        if now - self._last_purge > 3600:
            self._last_purge = now
            self.purge()

    def delete_demo(self) -> int:
        return self.db.execute("DELETE FROM audit_events WHERE is_demo = 1")

    def clear_all(self) -> int:
        return self.db.execute("DELETE FROM audit_events")
