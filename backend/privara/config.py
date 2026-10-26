"""Runtime configuration, read from environment variables (prefix PRIVARA_) or a .env file."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="PRIVARA_",
        env_file=(str(REPO_ROOT / ".env"), ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = 8787

    data_dir: Path = REPO_ROOT / "data"
    sandbox_dir: Path | None = None  # defaults to <data_dir>/sandbox
    frontend_dist: Path = REPO_ROOT / "frontend" / "dist"

    # Optional bootstrap admin key. Only its hash is kept in memory; it is never logged or stored.
    admin_api_key: SecretStr | None = None

    # Used by `privara mcp` (stdio transport) to authenticate the connecting agent.
    agent_key: SecretStr | None = None

    approval_ttl_seconds: int = Field(default=300, ge=10, le=86_400)
    pending_approval_ttl_seconds: int = Field(default=3600, ge=60, le=7 * 86_400)
    max_request_bytes: int = Field(default=256 * 1024, ge=1024)
    max_text_chars: int = Field(default=50_000, ge=100)
    max_file_bytes: int = Field(default=1024 * 1024, ge=1024)

    nlp_enabled: bool = True
    nlp_model: str = "en_core_web_sm"

    mcp_http_enabled: bool = True
    # Host headers accepted by the server (DNS-rebinding protection for a localhost service).
    allowed_hosts: str = "localhost,127.0.0.1,[::1]"
    log_level: str = "INFO"

    # "local": runs next to your agents (default). "hosted": runs on a server behind HTTPS — trusts the
    # platform's proxy headers, requires a strong admin key and adjusts what the dashboard says.
    deployment: Literal["local", "hosted"] = "local"
    # Failed authentication attempts allowed per client IP per minute before answering 429.
    auth_failures_per_minute: int = Field(default=20, ge=1, le=10_000)

    @property
    def is_hosted(self) -> bool:
        return self.deployment == "hosted"

    @property
    def allowed_host_list(self) -> list[str]:
        """Configured hosts plus the public hostname a hosting platform announces, if any."""
        hosts = [h.strip() for h in self.allowed_hosts.split(",") if h.strip()]
        platform = [
            os.environ.get("RENDER_EXTERNAL_HOSTNAME"),
            os.environ.get("RAILWAY_PUBLIC_DOMAIN"),
            f"{os.environ['FLY_APP_NAME']}.fly.dev" if os.environ.get("FLY_APP_NAME") else None,
        ]
        for host in platform:
            if host and host not in hosts:
                hosts.append(host)
        return hosts

    @property
    def listen_port(self) -> int:
        """PRIVARA_PORT, or the PORT that platforms such as Render and Railway assign."""
        if "PRIVARA_PORT" not in os.environ and os.environ.get("PORT", "").isdigit():
            return int(os.environ["PORT"])
        return self.port

    @property
    def sandbox_path(self) -> Path:
        return (self.sandbox_dir or (self.data_dir / "sandbox")).resolve()

    @property
    def main_db_path(self) -> Path:
        return self.data_dir / "privara.db"

    @property
    def vault_db_path(self) -> Path:
        return self.data_dir / "vault.db"

    @property
    def vault_key_path(self) -> Path:
        return self.data_dir / "vault.key"


@lru_cache
def get_settings() -> Settings:
    return Settings()
