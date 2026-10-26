import json

import pytest

from .conftest import PII, SAMPLE, bearer


@pytest.fixture
def agent_key(container):
    return container.agents.create("rest-agent")[1]


def test_health_is_public_and_reports_real_checks(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok" and body["checks"] == {"database": True, "vault": True, "sandbox": True}
    assert "nosniff" in response.headers["x-content-type-options"]


@pytest.mark.parametrize("header", [None, "Bearer nope", "Basic abc", "Bearer pv_agent_000000000000_" + "a" * 43])
def test_agent_endpoints_require_valid_key(client, header):
    headers = {"Authorization": header} if header else {}
    response = client.post("/api/v1/sanitize", json={"text": "hi"}, headers=headers)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


def test_admin_and_agent_keys_are_not_interchangeable(client, admin_key, agent_key):
    assert client.post("/api/v1/sanitize", json={"text": "hi"}, headers=bearer(admin_key)).status_code == 401
    assert client.get("/api/admin/overview", headers=bearer(agent_key)).status_code == 401
    assert client.get("/api/admin/overview").status_code == 401


def test_sanitize_endpoint(client, agent_key):
    response = client.post("/api/v1/sanitize", json={"text": SAMPLE, "session_id": "web"}, headers=bearer(agent_key))
    assert response.status_code == 200
    assert response.json()["sanitized_text"] == "Send [PERSON_1] the invoice for [AMOUNT_1] at [EMAIL_1]."


def test_validation_errors_do_not_echo_input(client, agent_key):
    response = client.post(
        "/api/v1/sanitize", json={"text": SAMPLE, "unexpected": PII["email"], "session_id": "bad id!"},
        headers=bearer(agent_key),
    )
    assert response.status_code == 422
    body = response.text
    assert PII["email"] not in body and PII["person"] not in body
    assert json.loads(body)["error"]["code"] == "validation_failed"


def test_request_size_limit(client, agent_key):
    big = "a" * (70 * 1024)
    response = client.post("/api/v1/sanitize", json={"text": big}, headers=bearer(agent_key))
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


def test_untrusted_host_header_is_rejected(client):
    assert client.get("/api/health", headers={"host": "evil.example.com"}).status_code == 400


def test_execute_status_codes(client, agent_key):
    ok = client.post("/api/v1/execute", json={"tool_name": "read_file", "arguments": {"path": "notes/welcome.txt"}},
                     headers=bearer(agent_key))
    assert ok.status_code == 200 and ok.json()["status"] == "executed"
    denied = client.post("/api/v1/execute", json={"tool_name": "read_file", "arguments": {"path": "../vault.key"}},
                         headers=bearer(agent_key))
    assert denied.status_code == 403 and denied.json()["decision"] == "deny"
    pending = client.post(
        "/api/v1/execute",
        json={"tool_name": "write_file", "arguments": {"path": "outbox/a.txt", "content": "x", "mode": "overwrite"}},
        headers=bearer(agent_key),
    )
    assert pending.status_code == 202 and pending.json()["status"] == "approval_required"


def test_approval_flow_over_rest(client, admin_key, agent_key):
    payload = {"tool_name": "write_file", "arguments": {"path": "outbox/b.txt", "content": "x", "mode": "overwrite"}}
    request_id = client.post("/api/v1/execute", json=payload, headers=bearer(agent_key)).json()["approval_request_id"]
    assert client.get("/api/admin/approvals?status=pending", headers=bearer(admin_key)).json()["items"][0]["id"] == request_id
    assert client.post(f"/api/admin/approvals/{request_id}/approve", headers=bearer(admin_key)).json()["status"] == "approved"
    token = client.get(f"/api/v1/approvals/{request_id}", headers=bearer(agent_key)).json()["approval_token"]
    done = client.post("/api/v1/execute", json={**payload, "approval_token": token}, headers=bearer(agent_key))
    assert done.status_code == 200 and done.json()["status"] == "executed"
    again = client.post("/api/v1/execute", json={**payload, "approval_token": token}, headers=bearer(agent_key))
    assert again.status_code == 403 and again.json()["reason"] == "token_reused"


def test_agent_id_claim_must_match(client, agent_key):
    response = client.post("/api/v1/sanitize", json={"text": "x", "agent_id": "agt_someone_else"}, headers=bearer(agent_key))
    assert response.status_code == 403 and response.json()["error"]["code"] == "agent_mismatch"


def test_agent_lifecycle_and_immediate_revocation(client, admin_key):
    created = client.post("/api/admin/agents", json={"name": "lifecycle"}, headers=bearer(admin_key))
    assert created.status_code == 201
    key, agent_id = created.json()["api_key"], created.json()["agent"]["id"]
    listing = client.get("/api/admin/agents", headers=bearer(admin_key)).text
    assert key not in listing and "key_hash" not in listing
    assert client.get("/api/v1/whoami", headers=bearer(key)).status_code == 200
    client.post(f"/api/admin/agents/{agent_id}/revoke", headers=bearer(admin_key))
    revoked = client.get("/api/v1/whoami", headers=bearer(key))
    assert revoked.status_code == 403 and revoked.json()["error"]["code"] == "agent_revoked"
    client.post(f"/api/admin/agents/{agent_id}/reactivate", headers=bearer(admin_key))
    rotated = client.post(f"/api/admin/agents/{agent_id}/rotate", headers=bearer(admin_key)).json()["api_key"]
    assert client.get("/api/v1/whoami", headers=bearer(key)).status_code == 401
    assert client.get("/api/v1/whoami", headers=bearer(rotated)).status_code == 200
    scopes = client.get(f"/api/admin/agents/{agent_id}/scopes", headers=bearer(admin_key)).json()
    assert any(p["id"] == "pol_seed_sandbox_read" for p in scopes["policies"])


def test_policy_crud_and_explain(client, admin_key):
    created = client.post("/api/admin/policies", headers=bearer(admin_key), json={
        "name": "block notes", "action": "file.read", "resource": "sandbox:notes/*", "decision": "deny", "priority": 300,
    })
    assert created.status_code == 201
    policy_id = created.json()["id"]
    explain = client.post("/api/admin/policies/explain", headers=bearer(admin_key),
                          json={"agent_id": "*", "action": "file.read", "resource": "sandbox:notes/a.txt"}).json()
    assert explain["decision"] == "deny" and explain["policy"]["id"] == policy_id and len(explain["matches"]) == 2
    patched = client.patch(f"/api/admin/policies/{policy_id}", json={"enabled": False}, headers=bearer(admin_key))
    assert patched.json()["enabled"] is False
    bad = client.post("/api/admin/policies", headers=bearer(admin_key),
                      json={"name": "x", "action": "file.read", "resource": "/etc", "decision": "allow"})
    assert bad.status_code == 422 and bad.json()["error"]["details"][0]["field"] == "resource"
    assert client.delete("/api/admin/policies/pol_seed_restore", headers=bearer(admin_key)).status_code == 422
    assert client.delete(f"/api/admin/policies/{policy_id}", headers=bearer(admin_key)).status_code == 200


def test_settings_validation_and_confirmation(client, admin_key):
    assert client.patch("/api/admin/settings", json={"audit_retention_days": -1}, headers=bearer(admin_key)).status_code == 422
    ok = client.patch("/api/admin/settings", json={"default_categories": ["EMAIL"]}, headers=bearer(admin_key))
    assert ok.json()["settings"]["default_categories"] == ["EMAIL"]
    unconfirmed = client.post("/api/admin/sessions/clear", json={}, headers=bearer(admin_key))
    assert unconfirmed.status_code == 422 and unconfirmed.json()["error"]["code"] == "confirmation_required"
    storage = client.get("/api/admin/settings", headers=bearer(admin_key)).json()["storage"]
    assert storage["main_db"]["mode"] == "0o600" and "Not encrypted" in storage["encryption"]["main_db"]


def test_lab_sanitize_and_restore_via_approval(client, admin_key):
    lab = client.post("/api/admin/lab/sanitize", json={"text": SAMPLE, "session_id": "lab-1"}, headers=bearer(admin_key)).json()
    assert len(lab["entities"]) == 3
    first = client.post("/api/admin/lab/restore", headers=bearer(admin_key),
                        json={"text": lab["sanitized_text"], "redaction_session_id": lab["redaction_session_id"]}).json()
    assert first["status"] == "approval_required"
    client.post(f"/api/admin/approvals/{first['approval_request_id']}/approve", headers=bearer(admin_key))
    second = client.post("/api/admin/lab/restore", headers=bearer(admin_key), json={
        "text": lab["sanitized_text"], "redaction_session_id": lab["redaction_session_id"],
        "approval_request_id": first["approval_request_id"],
    }).json()
    assert second["status"] == "restored" and second["restored_text"] == SAMPLE


def test_demo_run_and_reset_keeps_user_policies(client, admin_key):
    client.post("/api/admin/policies", headers=bearer(admin_key),
                json={"name": "keep me", "action": "file.read", "resource": "sandbox:x", "decision": "deny"})
    result = client.post("/api/admin/demo/run", headers=bearer(admin_key)).json()
    assert result["all_passed"], result
    overview = client.get("/api/admin/overview", headers=bearer(admin_key)).json()
    assert overview["redactions"] >= 3 and overview["blocked"] >= 1
    reset = client.post("/api/admin/demo/reset", json={"confirm": True}, headers=bearer(admin_key)).json()
    assert reset["removed_events"] > 0 and reset["policies_reset"] is False
    names = [p["name"] for p in client.get("/api/admin/policies", headers=bearer(admin_key)).json()["items"]]
    assert "keep me" in names
    assert client.get("/api/admin/activity", headers=bearer(admin_key)).json()["total"] == 0


def test_activity_filters(client, admin_key, agent_key):
    client.post("/api/v1/execute", json={"tool_name": "read_file", "arguments": {"path": "../x"}}, headers=bearer(agent_key))
    client.post("/api/v1/sanitize", json={"text": SAMPLE}, headers=bearer(agent_key))
    denied = client.get("/api/admin/activity?decision=deny", headers=bearer(admin_key)).json()
    assert denied["total"] == 1 and denied["items"][0]["outcome"] == "blocked"
    by_action = client.get("/api/admin/activity?action=privacy.sanitize", headers=bearer(admin_key)).json()
    assert by_action["total"] == 1 and by_action["items"][0]["redaction_count"] == 3
    detail = client.get(f"/api/admin/activity/{denied['items'][0]['id']}", headers=bearer(admin_key)).json()
    assert detail["event"]["executed"] is False
    assert client.get("/api/admin/activity?since=2999-01-01", headers=bearer(admin_key)).json()["total"] == 0


def test_admin_key_rotation(client, admin_key):
    new_key = client.post("/api/admin/credentials/rotate", json={"confirm": True}, headers=bearer(admin_key)).json()["api_key"]
    assert client.get("/api/admin/overview", headers=bearer(admin_key)).status_code == 401
    assert client.get("/api/admin/overview", headers=bearer(new_key)).status_code == 200


def test_env_bootstrap_admin_key(tmp_path):
    from fastapi.testclient import TestClient

    from privara.api import create_app

    from .conftest import make_settings

    settings = make_settings(tmp_path, admin_api_key="my-local-dev-admin-key-123")
    with TestClient(create_app(settings)) as c:
        assert c.get("/api/admin/overview", headers=bearer("my-local-dev-admin-key-123")).status_code == 200
        assert c.get("/api/admin/overview", headers=bearer("my-local-dev-admin-key-124")).status_code == 401
        creds = c.get("/api/admin/credentials", headers=bearer("my-local-dev-admin-key-123")).text
        assert "my-local-dev-admin-key-123" not in creds


MCP_HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}


def _rpc(method, params, id_=1):
    return {"jsonrpc": "2.0", "id": id_, "method": method, "params": params}


def test_mcp_http_endpoint(client, container, agent_key):
    unauth = client.post("/mcp", json=_rpc("tools/list", {}), headers=MCP_HEADERS)
    assert unauth.status_code == 401
    headers = {**MCP_HEADERS, **bearer(agent_key)}
    init = client.post("/mcp", headers=headers, json=_rpc("initialize", {
        "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "pytest", "version": "1"},
    }))
    assert init.status_code == 200 and init.json()["result"]["serverInfo"]["name"] == "Privara"
    call = client.post("/mcp", headers=headers, json=_rpc("tools/call", {
        "name": "sanitize_text", "arguments": {"text": SAMPLE},
    }, 2))
    assert call.status_code == 200
    payload = json.loads(call.json()["result"]["content"][0]["text"])
    assert payload["sanitized_text"] == "Send [PERSON_1] the invoice for [AMOUNT_1] at [EMAIL_1]."
