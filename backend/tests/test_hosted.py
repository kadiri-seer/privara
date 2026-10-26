import pytest
from fastapi.testclient import TestClient

from privara.api import create_app
from privara.throttle import AuthThrottle

from .conftest import bearer, make_settings

STRONG = "x" * 40


def test_failed_auth_is_throttled_per_client(tmp_path):
    settings = make_settings(tmp_path, auth_failures_per_minute=3)
    with TestClient(create_app(settings)) as client:
        for _ in range(3):
            assert client.get("/api/admin/overview", headers=bearer("wrong")).status_code == 401
        blocked = client.get("/api/admin/overview", headers=bearer("wrong"))
        assert blocked.status_code == 429 and blocked.json()["error"]["code"] == "too_many_attempts"
        assert client.post("/mcp", json={}, headers=bearer("wrong")).status_code == 429


def test_throttle_window_expires():
    now = [0.0]
    throttle = AuthThrottle(2, 60, clock=lambda: now[0])
    throttle.record_failure("a")
    throttle.record_failure("a")
    with pytest.raises(Exception):
        throttle.check("a")
    throttle.check("b")  # other clients unaffected
    now[0] = 61
    throttle.check("a")


def test_hosted_mode_rejects_weak_bootstrap_key(tmp_path):
    with pytest.raises(SystemExit):
        create_app(make_settings(tmp_path, deployment="hosted", admin_api_key="short-key"))


def test_platform_hostname_is_allowed(tmp_path, monkeypatch):
    monkeypatch.setenv("RENDER_EXTERNAL_HOSTNAME", "privara-api.onrender.com")
    settings = make_settings(tmp_path, allowed_hosts="privara-32np.vercel.app")
    assert settings.allowed_host_list == ["privara-32np.vercel.app", "privara-api.onrender.com"]
    with TestClient(create_app(settings), base_url="https://privara-api.onrender.com") as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/health", headers={"host": "evil.example"}).status_code == 400


def test_platform_port_is_used(monkeypatch, tmp_path):
    monkeypatch.delenv("PRIVARA_PORT", raising=False)
    monkeypatch.setenv("PORT", "10000")
    assert make_settings(tmp_path).listen_port == 10000


def test_hosted_integrations_and_health(tmp_path, monkeypatch):
    monkeypatch.setenv("RENDER_EXTERNAL_HOSTNAME", "privara-api.onrender.com")
    settings = make_settings(tmp_path, deployment="hosted", admin_api_key=STRONG,
                             allowed_hosts="privara-32np.vercel.app")
    with TestClient(create_app(settings), base_url="https://privara-api.onrender.com") as client:
        assert client.get("/api/health").json()["deployment"] == "hosted"
        data = client.get("/api/admin/integrations",
                          headers={**bearer(STRONG), "x-forwarded-host": "privara-32np.vercel.app"}).json()
        assert data["actual"]["mcp_stdio_command"] is None
        assert data["actual"]["mcp_http"] == "https://privara-32np.vercel.app/mcp"
        spoofed = client.get("/api/admin/integrations",
                             headers={**bearer(STRONG), "x-forwarded-host": "evil.example"}).json()
        assert spoofed["actual"]["base_url"] == "https://privara-api.onrender.com"


def test_mcp_responses_are_not_cacheable(client, container):
    key = container.agents.create("cache-agent")[1]
    response = client.post("/mcp", headers={**bearer(key), "accept": "application/json, text/event-stream"},
                           json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    assert response.headers["cache-control"] == "no-store"
