"""Operator-adjustable settings persisted in SQLite (validated on write)."""

from __future__ import annotations

from typing import Any

from .db import Database, dumps, loads
from .errors import ValidationFailed
from .privacy.recognizers import ALL_CATEGORIES, DEFAULT_CATEGORIES


class SettingsStore:
    def __init__(self, db: Database, approval_ttl_default: int):
        self.db = db
        self.defaults: dict[str, Any] = {
            "default_categories": list(DEFAULT_CATEGORIES),
            "detection_level": "medium",
            "default_decision": "deny",
            "audit_retention_days": 30,
            "approval_ttl_seconds": approval_ttl_default,
        }

    def get(self, key: str) -> Any:
        row = self.db.query_one("SELECT value FROM settings WHERE key = ?", (key,))
        return loads(row["value"]) if row else self.defaults[key]

    def all(self) -> dict[str, Any]:
        stored = {r["key"]: loads(r["value"]) for r in self.db.query("SELECT key, value FROM settings")}
        return {k: stored.get(k, v) for k, v in self.defaults.items()}

    def update(self, changes: dict[str, Any]) -> dict[str, Any]:
        problems: list[dict[str, str]] = []
        clean: dict[str, Any] = {}
        for key, value in changes.items():
            if key not in self.defaults:
                problems.append({"field": key, "message": "Unknown setting."})
            elif key == "default_categories":
                if not isinstance(value, list) or any(c not in ALL_CATEGORIES for c in value):
                    problems.append({"field": key, "message": "Must be a list of known categories."})
                else:
                    clean[key] = [c for c in ALL_CATEGORIES if c in value]
            elif key == "detection_level":
                if value not in ("low", "medium", "high"):
                    problems.append({"field": key, "message": "Must be low, medium or high."})
                else:
                    clean[key] = value
            elif key == "default_decision":
                if value not in ("deny", "approval_required"):
                    problems.append({"field": key, "message": "Default must be deny or approval_required."})
                else:
                    clean[key] = value
            elif key == "audit_retention_days":
                if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 3650:
                    problems.append({"field": key, "message": "Must be 0 (keep forever) to 3650 days."})
                else:
                    clean[key] = value
            elif key == "approval_ttl_seconds":
                if not isinstance(value, int) or isinstance(value, bool) or not 10 <= value <= 86_400:
                    problems.append({"field": key, "message": "Must be between 10 and 86400 seconds."})
                else:
                    clean[key] = value
        if problems:
            raise ValidationFailed("Settings are invalid.", details=problems)
        for key, value in clean.items():
            self.db.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, dumps(value)),
            )
        return self.all()
