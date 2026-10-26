"""SQLite persistence: connection helpers, schema migrations and file-permission hardening.

Two database files are used on purpose:

* ``privara.db`` holds agents, policies, approvals, settings and the audit log.
* ``vault.db`` holds reversible redaction mappings (encrypted values) and nothing else.

Keeping the vault separate means audit exports, backups or support bundles of the main
database never contain original sensitive values.
"""

from __future__ import annotations

import json
import os
import sqlite3
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

MAIN_MIGRATIONS: list[str] = [
    # 1 — initial schema
    """
    CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        is_system INTEGER NOT NULL DEFAULT 0,
        key_id TEXT UNIQUE,
        key_hash TEXT,
        created_at TEXT NOT NULL,
        key_rotated_at TEXT,
        last_seen_at TEXT,
        revoked_at TEXT
    );

    CREATE TABLE admin_credentials (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        key_id TEXT NOT NULL UNIQUE,
        key_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
    );

    CREATE TABLE policies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '*',
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'approval_required')),
        priority INTEGER NOT NULL DEFAULT 100,
        enabled INTEGER NOT NULL DEFAULT 1,
        origin TEXT NOT NULL CHECK (origin IN ('seed', 'user')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        tool_name TEXT,
        binding_hash TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '{}',
        policy_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','consumed','expired')),
        token_hash TEXT UNIQUE,
        token_issued INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        pending_expires_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        expires_at TEXT,
        consumed_at TEXT,
        is_demo INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE redaction_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        client_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        is_demo INTEGER NOT NULL DEFAULT 0,
        UNIQUE (agent_id, client_session_id)
    );

    CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        agent_id TEXT,
        agent_name TEXT,
        channel TEXT NOT NULL,
        action TEXT NOT NULL,
        tool_name TEXT,
        resource TEXT,
        decision TEXT NOT NULL,
        policy_id TEXT,
        policy_name TEXT,
        explanation TEXT NOT NULL,
        outcome TEXT NOT NULL,
        approval_status TEXT,
        approval_request_id TEXT,
        redaction_count INTEGER NOT NULL DEFAULT 0,
        entity_categories TEXT NOT NULL DEFAULT '[]',
        redaction_session_id TEXT,
        details TEXT NOT NULL DEFAULT '{}',
        is_demo INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_audit_ts ON audit_events (ts DESC);
    CREATE INDEX idx_audit_agent ON audit_events (agent_id);
    CREATE INDEX idx_audit_decision ON audit_events (decision);

    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """,
]

VAULT_MIGRATIONS: list[str] = [
    """
    CREATE TABLE mappings (
        session_id TEXT NOT NULL,
        placeholder TEXT NOT NULL,
        category TEXT NOT NULL,
        value_digest TEXT NOT NULL,
        value_ciphertext BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, placeholder),
        UNIQUE (session_id, category, value_digest)
    );
    """,
]


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(dt: datetime | None = None) -> str:
    return (dt or utcnow()).isoformat(timespec="milliseconds")


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value)


def harden_file(path: Path) -> None:
    """Restrict a file to the owning user (0600) where the platform supports it."""
    try:
        if path.exists():
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except (OSError, NotImplementedError):  # pragma: no cover - e.g. some Windows filesystems
        pass


def harden_dir(path: Path) -> None:
    try:
        os.chmod(path, stat.S_IRWXU)
    except (OSError, NotImplementedError):  # pragma: no cover
        pass


class Database:
    """Thin wrapper that opens short-lived connections. Every query must use parameters."""

    def __init__(self, path: Path, migrations: list[str]):
        self.path = path
        self.migrations = migrations

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 10000")
        return conn

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def migrate(self) -> int:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            for index, script in enumerate(self.migrations, start=1):
                if index <= version:
                    continue
                conn.executescript("BEGIN;" + script + f"PRAGMA user_version = {index};COMMIT;")
                version = index
        for suffix in ("", "-wal", "-shm"):
            harden_file(Path(str(self.path) + suffix))
        return version

    def query(self, sql: str, params: tuple | dict = ()) -> list[dict[str, Any]]:
        with self.connect() as conn:
            return [dict(row) for row in conn.execute(sql, params).fetchall()]

    def query_one(self, sql: str, params: tuple | dict = ()) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(sql, params).fetchone()
            return dict(row) if row else None

    def execute(self, sql: str, params: tuple | dict = ()) -> int:
        with self.connect() as conn:
            return conn.execute(sql, params).rowcount


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False)


def loads(value: str | None, default: Any = None) -> Any:
    if not value:
        return default
    return json.loads(value)
