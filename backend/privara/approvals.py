"""One-time, expiring approval tokens bound to an exact proposed action.

Lifecycle::

    pending ──approve──▶ approved ──agent fetches token (once)──▶ token issued
       │                    │                                         │
       └──deny──▶ denied     └──TTL──▶ expired          execute ──▶ consumed

The binding hash covers the agent id, action, tool, resource and the canonical JSON of the
validated arguments. A token is only accepted for a request whose binding hash matches, which
prevents approval substitution (approving one write and using the token for another).
Only a SHA-256 digest of the token is stored. Tokens are minted when the requesting agent first
collects them after approval, so plaintext tokens never sit in the database.
"""

from __future__ import annotations

import hashlib
import hmac
from datetime import timedelta
from typing import Any

from .db import Database, dumps, iso, loads, parse_iso, utcnow
from .errors import ConflictError, NotFoundError, PrivaraError
from .security import new_id, new_token


class ApprovalRejected(PrivaraError):
    status_code = 403
    code = "approval_rejected"


REJECTION_MESSAGES = {
    "token_invalid": "Approval token is not recognised.",
    "token_agent_mismatch": "Approval token was issued to a different agent.",
    "token_action_mismatch": "Approval token was issued for a different action or different arguments.",
    "token_expired": "Approval token has expired.",
    "token_reused": "Approval token has already been used.",
    "token_not_approved": "Approval request is not in an approved state.",
}


def binding_hash(agent_id: str, action: str, tool_name: str | None, resource: str, arguments: Any) -> str:
    canonical = dumps({"agent": agent_id, "action": action, "tool": tool_name, "resource": resource, "args": arguments})
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class Approvals:
    def __init__(self, db: Database, ttl_fn, pending_ttl_seconds: int, clock=utcnow):
        self.db = db
        self._ttl = ttl_fn
        self.pending_ttl_seconds = pending_ttl_seconds
        self.clock = clock

    def _public(self, row: dict[str, Any]) -> dict[str, Any]:
        data = {k: v for k, v in row.items() if k not in ("token_hash", "binding_hash")}
        data["summary"] = loads(row["summary"], {})
        data["token_issued"] = bool(row["token_issued"])
        data["is_demo"] = bool(row["is_demo"])
        return data

    def _refresh_expiry(self, row: dict[str, Any]) -> dict[str, Any]:
        now = self.clock()
        expired = (row["status"] == "pending" and now > parse_iso(row["pending_expires_at"])) or (
            row["status"] == "approved" and row["expires_at"] and now > parse_iso(row["expires_at"])
        )
        if expired:
            self.db.execute(
                "UPDATE approval_requests SET status = 'expired' WHERE id = ? AND status = ?", (row["id"], row["status"])
            )
            row = {**row, "status": "expired"}
        return row

    def create(
        self,
        *,
        agent_id: str,
        action: str,
        resource: str,
        tool_name: str | None,
        binding: str,
        summary: dict[str, Any],
        policy_id: str | None,
        is_demo: bool,
    ) -> dict[str, Any]:
        request_id = new_id("apr")
        now = self.clock()
        self.db.execute(
            "INSERT INTO approval_requests (id, agent_id, action, resource, tool_name, binding_hash, summary, policy_id,"
            " status, created_at, pending_expires_at, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
            (
                request_id, agent_id, action, resource, tool_name, binding, dumps(summary), policy_id, iso(now),
                iso(now + timedelta(seconds=self.pending_ttl_seconds)), int(is_demo),
            ),
        )
        return self.get(request_id)

    def get_row(self, request_id: str) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM approval_requests WHERE id = ?", (request_id,))
        if not row:
            raise NotFoundError("Approval request not found.")
        return self._refresh_expiry(row)

    def get(self, request_id: str) -> dict[str, Any]:
        return self._public(self.get_row(request_id))

    def list(self, status: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM approval_requests ORDER BY created_at DESC LIMIT ?", (limit,))
        rows = [self._refresh_expiry(r) for r in rows]
        if status:
            rows = [r for r in rows if r["status"] == status]
        return [self._public(r) for r in rows]

    def pending_count(self) -> int:
        return len(self.list("pending", limit=1000))

    def decide(self, request_id: str, approve: bool, decided_by: str) -> dict[str, Any]:
        row = self.get_row(request_id)
        if row["status"] != "pending":
            raise ConflictError(f"Approval request is already {row['status']}.", code="not_pending")
        now = self.clock()
        if approve:
            changed = self.db.execute(
                "UPDATE approval_requests SET status = 'approved', decided_at = ?, decided_by = ?, expires_at = ?"
                " WHERE id = ? AND status = 'pending'",
                (iso(now), decided_by, iso(now + timedelta(seconds=self._ttl())), request_id),
            )
        else:
            changed = self.db.execute(
                "UPDATE approval_requests SET status = 'denied', decided_at = ?, decided_by = ?"
                " WHERE id = ? AND status = 'pending'",
                (iso(now), decided_by, request_id),
            )
        if changed != 1:
            raise ConflictError("Approval request changed concurrently.", code="not_pending")
        return self.get(request_id)

    def collect(self, agent_id: str, request_id: str) -> dict[str, Any]:
        """Called by the requesting agent. Returns the token exactly once after approval."""
        row = self.get_row(request_id)
        if not hmac.compare_digest(row["agent_id"], agent_id):
            raise NotFoundError("Approval request not found.")
        result: dict[str, Any] = {
            "approval_request_id": row["id"],
            "status": row["status"],
            "expires_at": row["expires_at"],
            "approval_token": None,
        }
        if row["status"] == "approved" and not row["token_issued"]:
            token = new_token()
            changed = self.db.execute(
                "UPDATE approval_requests SET token_hash = ?, token_issued = 1 WHERE id = ? AND status = 'approved'"
                " AND token_issued = 0",
                (_token_digest(token), request_id),
            )
            if changed == 1:
                result["approval_token"] = token
                result["message"] = "Token issued. It is shown once, is single-use and expires at expires_at."
                return result
        if row["status"] == "approved":
            result["message"] = "Token was already collected; it is not shown again."
        else:
            result["message"] = {
                "pending": "Waiting for a human decision.",
                "denied": "The request was denied.",
                "consumed": "The approved action has already been executed.",
                "expired": "The request expired.",
            }.get(row["status"], "")
        return result

    def consume(self, agent_id: str, token: str, binding: str) -> dict[str, Any]:
        """Validate and atomically consume a token for exactly this binding. Raises ApprovalRejected."""
        row = self.db.query_one("SELECT * FROM approval_requests WHERE token_hash = ?", (_token_digest(token),))
        if not row:
            raise ApprovalRejected(REJECTION_MESSAGES["token_invalid"], code="token_invalid")
        row = self._refresh_expiry(row)
        if not hmac.compare_digest(row["agent_id"], agent_id):
            raise ApprovalRejected(REJECTION_MESSAGES["token_agent_mismatch"], code="token_agent_mismatch")
        if row["status"] == "consumed":
            raise ApprovalRejected(REJECTION_MESSAGES["token_reused"], code="token_reused")
        if row["status"] == "expired":
            raise ApprovalRejected(REJECTION_MESSAGES["token_expired"], code="token_expired")
        if row["status"] != "approved":
            raise ApprovalRejected(REJECTION_MESSAGES["token_not_approved"], code="token_not_approved")
        if not hmac.compare_digest(row["binding_hash"], binding):
            raise ApprovalRejected(REJECTION_MESSAGES["token_action_mismatch"], code="token_action_mismatch")
        changed = self.db.execute(
            "UPDATE approval_requests SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved'",
            (iso(self.clock()), row["id"]),
        )
        if changed != 1:
            raise ApprovalRejected(REJECTION_MESSAGES["token_reused"], code="token_reused")
        return self._public({**row, "status": "consumed"})

    def delete_demo(self) -> int:
        return self.db.execute("DELETE FROM approval_requests WHERE is_demo = 1")

    def expire_for_agent(self, agent_id: str) -> int:
        """Invalidate outstanding approvals when an agent is revoked."""
        return self.db.execute(
            "UPDATE approval_requests SET status = 'expired' WHERE agent_id = ? AND status IN ('pending','approved')",
            (agent_id,),
        )
