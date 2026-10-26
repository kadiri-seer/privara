"""Runtime configuration, read from environment variables (prefix PRIVARA_) or a .env file."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

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
