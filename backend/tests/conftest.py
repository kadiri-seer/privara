from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from privara.api import create_app
from privara.auth import Agent
from privara.config import Settings
from privara.core import Container, build

PII = {
    "person": "John Okafor",
    "email": "john@example.com",
    "amount": "₦250,000",
}
SAMPLE = f"Send {PII['person']} the invoice for {PII['amount']} at {PII['email']}."


def make_settings(tmp_path: Path, **overrides) -> Settings:
    values = dict(
        data_dir=tmp_path / "data",
        frontend_dist=tmp_path / "no-frontend",
        allowed_hosts="testserver,localhost,127.0.0.1",
        admin_api_key=None,
        agent_key=None,
        approval_ttl_seconds=60,
        max_request_bytes=64 * 1024,
        max_text_chars=20_000,
        log_level="WARNING",
    )
    values.update(overrides)
    return Settings(_env_file=None, **values)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return make_settings(tmp_path)


@pytest.fixture
def container(settings: Settings) -> Container:
    return build(settings)


@pytest.fixture
def gateway(container: Container):
    return container.gateway


@pytest.fixture
def agent_and_key(container: Container) -> tuple[Agent, str]:
    record, key = container.agents.create("test-agent", "pytest")
    return container.agents.authenticate(key), key


@pytest.fixture
def agent(agent_and_key) -> Agent:
    return agent_and_key[0]


@pytest.fixture
def other_agent(container: Container) -> Agent:
    _, key = container.agents.create("other-agent")
    return container.agents.authenticate(key)


@pytest.fixture
def admin_key(container: Container) -> str:
    return container.admin.create("pytest")


@pytest.fixture
def client(settings: Settings, container: Container):
    app = create_app(settings, container)
    with TestClient(app) as test_client:
        yield test_client


def bearer(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def approve_and_collect(container: Container, agent: Agent, request_id: str) -> str:
    container.gateway.decide_approval(request_id, True, "pytest")
    collected = container.gateway.get_approval(agent, request_id)
    assert collected["approval_token"]
    return collected["approval_token"]
