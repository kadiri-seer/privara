import json

from mcp.shared.memory import create_connected_server_and_client_session

from privara.mcp_server import build_mcp, env_key_resolver

from .conftest import PII, SAMPLE, approve_and_collect


def payload(result):
    return json.loads(result.content[0].text)


async def test_mcp_exposes_required_tools(container, agent_and_key):
    _, key = agent_and_key
    server = build_mcp(container, env_key_resolver(key))
    async with create_connected_server_and_client_session(server._mcp_server) as client:
        names = {t.name for t in (await client.list_tools()).tools}
        assert {"sanitize_text", "check_permission", "execute_tool", "restore_text"} <= names


async def test_mcp_tool_invocation_end_to_end(container, agent_and_key):
    agent, key = agent_and_key
    server = build_mcp(container, env_key_resolver(key))
    async with create_connected_server_and_client_session(server._mcp_server) as client:
        sanitized = payload(await client.call_tool("sanitize_text", {"text": SAMPLE, "session_id": "m1"}))
        assert sanitized["sanitized_text"] == "Send [PERSON_1] the invoice for [AMOUNT_1] at [EMAIL_1]."

        permission = payload(await client.call_tool("check_permission", {"action": "file.read", "resource": "outside:/etc"}))
        assert permission["decision"] == "deny" and permission["decision_id"].startswith("evt_")

        restore = payload(await client.call_tool("restore_text", {
            "text": sanitized["sanitized_text"], "redaction_session_id": sanitized["redaction_session_id"],
        }))
        assert restore["status"] == "approval_required"
        container.gateway.decide_approval(restore["approval_request_id"], True, "pytest")
        token = payload(await client.call_tool("get_approval", {"approval_request_id": restore["approval_request_id"]}))["approval_token"]
        restored = payload(await client.call_tool("restore_text", {
            "text": sanitized["sanitized_text"], "redaction_session_id": sanitized["redaction_session_id"],
            "approval_token": token,
        }))
        assert restored["restored_text"] == SAMPLE

        executed = payload(await client.call_tool("execute_tool", {
            "tool_name": "transform_text", "arguments": {"operation": "slugify", "text": "Hello World"},
        }))
        assert executed["result"]["output"] == "hello-world"


async def test_mcp_invalid_arguments_do_not_echo_values(container, agent_and_key):
    _, key = agent_and_key
    server = build_mcp(container, env_key_resolver(key))
    async with create_connected_server_and_client_session(server._mcp_server) as client:
        result = await client.call_tool("sanitize_text", {"txt": SAMPLE})  # wrong field name
        assert result.isError
        text = result.content[0].text
        assert "text" in text and PII["person"] not in text and PII["email"] not in text


async def test_mcp_rejects_bad_key_revoked_agent_and_mismatched_claim(container, agent_and_key):
    agent, key = agent_and_key
    bad = build_mcp(container, env_key_resolver("pv_agent_000000000000_" + "x" * 43))
    async with create_connected_server_and_client_session(bad._mcp_server) as client:
        assert payload(await client.call_tool("sanitize_text", {"text": "x"}))["error"]["code"] == "unauthenticated"

    server = build_mcp(container, env_key_resolver(key))
    async with create_connected_server_and_client_session(server._mcp_server) as client:
        mismatch = payload(await client.call_tool("sanitize_text", {"text": "x", "agent_id": "agt_other"}))
        assert mismatch["error"]["code"] == "agent_mismatch"
        ok = payload(await client.call_tool("sanitize_text", {"text": "x", "agent_id": agent.id}))
        assert ok["status"] == "sanitized"
        container.agents.set_status(agent.id, "revoked")  # mid-session revocation
        revoked = payload(await client.call_tool("sanitize_text", {"text": "x"}))
        assert revoked["error"]["code"] == "agent_revoked"


async def test_mcp_approval_token_substitution_blocked(container, agent_and_key):
    agent, key = agent_and_key
    server = build_mcp(container, env_key_resolver(key))
    args = {"path": "outbox/x.txt", "content": "approved content", "mode": "overwrite"}
    async with create_connected_server_and_client_session(server._mcp_server) as client:
        pending = payload(await client.call_tool("execute_tool", {"tool_name": "write_file", "arguments": args}))
        token = approve_and_collect(container, agent, pending["approval_request_id"])
        swapped = payload(await client.call_tool("execute_tool", {
            "tool_name": "write_file", "arguments": {**args, "content": "malicious"}, "approval_token": token,
        }))
        assert swapped["status"] == "approval_rejected"
        assert not (container.sandbox / "outbox" / "x.txt").exists()
