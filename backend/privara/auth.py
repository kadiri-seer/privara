"""Agent identities and admin (operator) credentials."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .db import Database, iso
from .errors import AuthenticationError, ConflictError, ForbiddenError, NotFoundError, ValidationFailed
from .security import constant_time_equals, digest_key, generate_key, new_id, parse_key, verify_digest

AGENT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{1,63}$")
LAB_AGENT_ID = "agt_privacy_lab"
DEMO_AGENT_ID = "agt_demo"
SYSTEM_AGENTS = [
    (LAB_AGENT_ID, "privacy-lab", "Built-in identity used by the Privacy Lab page. It has no external credential."),
    (DEMO_AGENT_ID, "privara-demo", "Built-in demonstration agent. Its key is rotated on every demo run."),
]
PUBLIC_AGENT_FIELDS = (
    "id", "name", "description", "status", "is_system", "created_at", "key_rotated_at", "last_seen_at", "revoked_at",
)


@dataclass(frozen=True)
class Agent:
    id: str
    name: str
    status: str
    is_system: bool

    @property
    def is_demo(self) -> bool:
        return self.id == DEMO_AGENT_ID


def public_agent(row: dict[str, Any]) -> dict[str, Any]:
    data = {k: row.get(k) for k in PUBLIC_AGENT_FIELDS}
    data["is_system"] = bool(data["is_system"])
    data["has_credential"] = bool(row.get("key_hash"))
    return data


class AgentStore:
    def __init__(self, db: Database):
        self.db = db

    def ensure_system_agents(self) -> None:
        now = iso()
        for agent_id, name, description in SYSTEM_AGENTS:
            self.db.execute(
                "INSERT OR IGNORE INTO agents (id, name, description, status, is_system, created_at)"
                " VALUES (?, ?, ?, 'active', 1, ?)",
                (agent_id, name, description, now),
            )

    def list(self) -> list[dict[str, Any]]:
        return [public_agent(r) for r in self.db.query("SELECT * FROM agents ORDER BY is_system, created_at")]

    def get_row(self, agent_id: str) -> dict[str, Any]:
        row = self.db.query_one("SELECT * FROM agents WHERE id = ?", (agent_id,))
        if not row:
            raise NotFoundError("Agent not found.")
        return row

    def get(self, agent_id: str) -> dict[str, Any]:
        return public_agent(self.get_row(agent_id))

    def as_agent(self, agent_id: str) -> Agent:
        row = self.get_row(agent_id)
        return Agent(row["id"], row["name"], row["status"], bool(row["is_system"]))

    def create(self, name: str, description: str = "") -> tuple[dict[str, Any], str]:
        name = (name or "").strip()
        if not AGENT_NAME_RE.match(name):
            raise ValidationFailed(
                "Agent name must be 2–64 characters: letters, digits, space, '.', '_' or '-'.",
                details=[{"field": "name", "message": "invalid format"}],
            )
        if self.db.query_one("SELECT id FROM agents WHERE name = ?", (name,)):
            raise ConflictError("An agent with this name already exists.")
        key = generate_key("agent")
        agent_id = new_id("agt")
        now = iso()
        self.db.execute(
            "INSERT INTO agents (id, name, description, status, is_system, key_id, key_hash, created_at, key_rotated_at)"
            " VALUES (?, ?, ?, 'active', 0, ?, ?, ?, ?)",
            (agent_id, name, (description or "").strip()[:300], key.key_id, key.digest, now, now),
        )
        return self.get(agent_id), key.plaintext

    def rotate(self, agent_id: str, *, allow_system: bool = False) -> tuple[dict[str, Any], str]:
        row = self.get_row(agent_id)
        if row["id"] == LAB_AGENT_ID or (row["is_system"] and not allow_system):
            raise ValidationFailed("Built-in agents do not use external credentials.", code="system_agent")
        key = generate_key("agent")
        self.db.execute(
            "UPDATE agents SET key_id = ?, key_hash = ?, key_rotated_at = ? WHERE id = ?",
            (key.key_id, key.digest, iso(), agent_id),
        )
        return self.get(agent_id), key.plaintext

    def set_status(self, agent_id: str, status: str) -> dict[str, Any]:
        row = self.get_row(agent_id)
        if row["is_system"] and status == "revoked" and row["id"] == LAB_AGENT_ID:
            raise ValidationFailed("The Privacy Lab identity cannot be revoked.", code="system_agent")
        self.db.execute(
            "UPDATE agents SET status = ?, revoked_at = ? WHERE id = ?",
            (status, iso() if status == "revoked" else None, agent_id),
        )
        return self.get(agent_id)

    def authenticate(self, presented: str | None) -> Agent:
        """Verify an agent key. Status is read from the database on every call, so revocation
        takes effect on the very next request."""
        parsed = parse_key(presented)
        row = None
        if parsed and parsed[0] == "agent":
            row = self.db.query_one("SELECT * FROM agents WHERE key_id = ?", (parsed[1],))
        ok = verify_digest(presented or "", row["key_hash"] if row else None)
        if not ok or row is None:
            raise AuthenticationError("Missing or invalid agent credential.")
        if row["status"] != "active":
            raise ForbiddenError("This agent's access has been revoked.", code="agent_revoked")
        self.db.execute("UPDATE agents SET last_seen_at = ? WHERE id = ?", (iso(), row["id"]))
        return Agent(row["id"], row["name"], row["status"], bool(row["is_system"]))

    def require_active(self, agent_id: str) -> Agent:
        agent = self.as_agent(agent_id)
        if agent.status != "active":
            raise ForbiddenError("This agent's access has been revoked.", code="agent_revoked")
        self.db.execute("UPDATE agents SET last_seen_at = ? WHERE id = ?", (iso(), agent_id))
        return agent


class AdminCredentials:
    def __init__(self, db: Database, bootstrap_key: str | None = None):
        self.db = db
        self._bootstrap_digest = digest_key(bootstrap_key) if bootstrap_key else None

    def has_any(self) -> bool:
        if self._bootstrap_digest:
            return True
        return bool(self.db.query_one("SELECT id FROM admin_credentials WHERE revoked_at IS NULL"))

    def create(self, label: str = "admin") -> str:
        key = generate_key("admin")
        self.db.execute(
            "INSERT INTO admin_credentials (id, label, key_id, key_hash, created_at) VALUES (?, ?, ?, ?, ?)",
            (new_id("adm"), label[:60], key.key_id, key.digest, iso()),
        )
        return key.plaintext

    def rotate(self, current_key_id: str | None, label: str = "admin") -> str:
        """Issue a new admin key and revoke all other stored admin keys."""
        new_key = self.create(label)
        new_parsed = parse_key(new_key)
        assert new_parsed is not None
        self.db.execute(
            "UPDATE admin_credentials SET revoked_at = ? WHERE revoked_at IS NULL AND key_id != ?",
            (iso(), new_parsed[1]),
        )
        return new_key

    def list(self) -> list[dict[str, Any]]:
        rows = self.db.query(
            "SELECT id, label, key_id, created_at, last_used_at, revoked_at FROM admin_credentials ORDER BY created_at DESC"
        )
        result = [{**r, "source": "database"} for r in rows]
        if self._bootstrap_digest:
            result.insert(0, {"id": "env", "label": "PRIVARA_ADMIN_API_KEY", "key_id": None, "source": "environment",
                              "created_at": None, "last_used_at": None, "revoked_at": None})
        return result

    def authenticate(self, presented: str | None) -> str:
        """Return the credential id that matched, or raise."""
        if presented and self._bootstrap_digest and constant_time_equals(digest_key(presented), self._bootstrap_digest):
            return "env"
        parsed = parse_key(presented)
        row = None
        if parsed and parsed[0] == "admin":
            row = self.db.query_one(
                "SELECT id, key_hash FROM admin_credentials WHERE key_id = ? AND revoked_at IS NULL", (parsed[1],)
            )
        if not verify_digest(presented or "", row["key_hash"] if row else None) or row is None:
            raise AuthenticationError("Missing or invalid admin credential.")
        self.db.execute("UPDATE admin_credentials SET last_used_at = ? WHERE id = ?", (iso(), row["id"]))
        return row["id"]
