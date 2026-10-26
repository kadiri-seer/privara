"""Local store for reversible redaction mappings.

Values are encrypted with Fernet (AES-128-CBC + HMAC-SHA256) using a key stored next to the
database in ``vault.key`` (mode 0600). Placeholder reuse is decided by an HMAC digest of the
normalised value, so equal values map to the same placeholder without storing plaintext.

Honest scope: because the key lives on the same disk, this protects against someone who
obtains a copy of ``vault.db`` alone (e.g. a stray backup); it does NOT protect against an
attacker who can read the whole data directory as the Privara user.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import sqlite3
from pathlib import Path

from cryptography.fernet import Fernet

from ..db import Database, harden_file, iso


def normalise(value: str) -> str:
    return " ".join(value.split()).casefold()


def load_or_create_key(path: Path) -> bytes:
    if path.exists():
        return path.read_bytes().strip()
    path.parent.mkdir(parents=True, exist_ok=True)
    key = Fernet.generate_key()
    # Create with restrictive permissions from the start.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with open(fd, "wb") as handle:
        handle.write(key)
    harden_file(path)
    return key


class Vault:
    def __init__(self, db: Database, key: bytes):
        self.db = db
        self._fernet = Fernet(key)
        self._digest_key = hashlib.sha256(b"privara-vault-digest:" + key).digest()

    def _digest(self, category: str, value: str) -> str:
        message = f"{category}\x00{normalise(value)}".encode("utf-8")
        return hmac.new(self._digest_key, message, hashlib.sha256).hexdigest()

    def placeholder_for(self, session_id: str, category: str, value: str) -> str:
        """Return the existing placeholder for this value in the session, or allocate a new one."""
        digest = self._digest(category, value)
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT placeholder FROM mappings WHERE session_id = ? AND category = ? AND value_digest = ?",
                (session_id, category, digest),
            ).fetchone()
            if row:
                return row["placeholder"]
            count = conn.execute(
                "SELECT COUNT(*) FROM mappings WHERE session_id = ? AND category = ?",
                (session_id, category),
            ).fetchone()[0]
            placeholder = f"[{category}_{count + 1}]"
            try:
                conn.execute(
                    "INSERT INTO mappings (session_id, placeholder, category, value_digest, value_ciphertext, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (session_id, placeholder, category, digest, self._fernet.encrypt(value.encode("utf-8")), iso()),
                )
            except sqlite3.IntegrityError:  # pragma: no cover - guarded by BEGIN IMMEDIATE
                raise
            return placeholder

    def resolve(self, session_id: str) -> dict[str, str]:
        """Decrypt the mapping for one session. Callers must have passed authorization first."""
        rows = self.db.query(
            "SELECT placeholder, value_ciphertext FROM mappings WHERE session_id = ?", (session_id,)
        )
        return {row["placeholder"]: self._fernet.decrypt(row["value_ciphertext"]).decode("utf-8") for row in rows}

    def placeholders(self, session_id: str) -> list[dict[str, str]]:
        return self.db.query(
            "SELECT placeholder, category, created_at FROM mappings WHERE session_id = ? ORDER BY created_at",
            (session_id,),
        )

    def clear_session(self, session_id: str) -> int:
        return self.db.execute("DELETE FROM mappings WHERE session_id = ?", (session_id,))

    def clear_sessions(self, session_ids: list[str]) -> int:
        removed = 0
        for session_id in session_ids:
            removed += self.clear_session(session_id)
        return removed

    def clear_all(self) -> int:
        removed = self.db.execute("DELETE FROM mappings")
        with self.db.connect() as conn:
            conn.execute("VACUUM")
        return removed

    def count(self) -> int:
        row = self.db.query_one("SELECT COUNT(*) AS n FROM mappings")
        return int(row["n"]) if row else 0
