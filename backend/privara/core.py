"""Builds and initialises the application container (databases, engines, gateway)."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

from .approvals import Approvals
from .audit import AuditLog
from .auth import AdminCredentials, AgentStore
from .config import Settings
from .db import MAIN_MIGRATIONS, VAULT_MIGRATIONS, Database, harden_dir, harden_file
from .gateway import Gateway
from .policy.engine import PolicyEngine
from .privacy.engine import Detector, PrivacyEngine
from .privacy.vault import Vault, load_or_create_key
from .settings_store import SettingsStore
from .tools.registry import ToolContext

log = logging.getLogger("privara")

SANDBOX_SEED_FILES = {
    "README.txt": (
        "This is the Privara sandbox. Agents can only read and write files inside this folder,\n"
        "and only as far as policy allows.\n\n"
        "  notes/     readable and writable\n"
        "  outbox/    writes require human approval\n"
        "  protected/ readable, never writable by agents\n"
    ),
    "notes/welcome.txt": "Welcome to Privara. This file is safe to read from the sandbox.\n",
    "notes/client-brief.txt": (
        "Client brief\n\nPrimary contact: Amina Bello, amina.bello@example.org, +234 803 555 0142.\n"
        "Budget approved: ₦1,500,000. Kick-off is next Tuesday in Kaduna.\n"
    ),
    "protected/policy-notice.txt": "Files in protected/ can be read but never written by agents.\n",
    "outbox/.keep": "",
}


@dataclass
class Container:
    settings: Settings
    main_db: Database
    vault_db: Database
    agents: AgentStore
    admin: AdminCredentials
    store: SettingsStore
    policies: PolicyEngine
    approvals: Approvals
    audit: AuditLog
    privacy: PrivacyEngine
    gateway: Gateway

    @property
    def sandbox(self) -> Path:
        return self.settings.sandbox_path


def seed_sandbox(sandbox: Path, *, overwrite: bool = False) -> None:
    sandbox.mkdir(parents=True, exist_ok=True)
    for relative, content in SANDBOX_SEED_FILES.items():
        path = sandbox / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if overwrite or not path.exists():
            path.write_text(content, encoding="utf-8")


def build(settings: Settings) -> Container:
    # New files (databases, WAL/SHM side files, vault key, sandbox writes) are owner-only.
    try:
        os.umask(0o077)
    except (OSError, NotImplementedError):  # pragma: no cover
        pass
    data_dir = settings.data_dir
    data_dir.mkdir(parents=True, exist_ok=True)
    harden_dir(data_dir)

    main_db = Database(settings.main_db_path, MAIN_MIGRATIONS)
    vault_db = Database(settings.vault_db_path, VAULT_MIGRATIONS)
    main_db.migrate()
    vault_db.migrate()
    key = load_or_create_key(settings.vault_key_path)
    harden_file(settings.vault_key_path)

    store = SettingsStore(main_db, settings.approval_ttl_seconds)
    agents = AgentStore(main_db)
    agents.ensure_system_agents()
    admin = AdminCredentials(
        main_db, settings.admin_api_key.get_secret_value() if settings.admin_api_key else None
    )
    policies = PolicyEngine(main_db, lambda: store.get("default_decision"))
    policies.seed()
    approvals = Approvals(main_db, lambda: store.get("approval_ttl_seconds"), settings.pending_approval_ttl_seconds)
    audit = AuditLog(main_db, lambda: store.get("audit_retention_days"))
    audit.purge()

    detector = Detector.get(settings.nlp_enabled, settings.nlp_model)
    privacy = PrivacyEngine(detector, Vault(vault_db, key))

    if not settings.sandbox_path.exists():
        seed_sandbox(settings.sandbox_path)
    tool_context = ToolContext(sandbox=settings.sandbox_path, max_file_bytes=settings.max_file_bytes)

    gateway = Gateway(
        main_db=main_db, agents=agents, policies=policies, approvals=approvals, audit=audit, privacy=privacy,
        settings=store, tool_context=tool_context, max_text_chars=settings.max_text_chars,
    )
    return Container(
        settings=settings, main_db=main_db, vault_db=vault_db, agents=agents, admin=admin, store=store,
        policies=policies, approvals=approvals, audit=audit, privacy=privacy, gateway=gateway,
    )
