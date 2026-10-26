"""Built-in demonstration agent.

The demo talks to the real gateway over the real MCP protocol (an in-memory transport instead of
stdio/HTTP), authenticated with a freshly rotated credential for the built-in ``privara-demo``
agent. Every event it produces is a genuine policy decision or execution. The only automated
human step is the approval, which is performed through the same operator code path as the
dashboard and is labelled as such in the audit log.
"""

from __future__ import annotations

import json
from typing import Any

from mcp.shared.memory import create_connected_server_and_client_session

from .auth import DEMO_AGENT_ID
from .core import Container, seed_sandbox
from .mcp_server import build_mcp, env_key_resolver

SAMPLE_TASK = "Send John Okafor the invoice for ₦250,000 at john@example.com."
DEMO_OPERATOR = "demo-run auto-approval (operator step simulated by the demo; the approval itself is real)"


def _payload(result: Any) -> dict[str, Any]:
    if getattr(result, "isError", False):
        text = "".join(getattr(c, "text", "") for c in result.content)
        return {"status": "error", "error": {"code": "mcp_error", "message": text[:300]}}
    for content in result.content:
        text = getattr(content, "text", None)
        if text:
            return json.loads(text)
    return {}


def _step(number: int, title: str, tool: str, payload: dict[str, Any], expectation: str, **extra: Any) -> dict[str, Any]:
    keep = ("status", "decision", "explanation", "decision_id", "approval_request_id", "reason", "message", "resource")
    summary = {k: payload[k] for k in keep if k in payload}
    if "error" in payload:
        summary["error"] = payload["error"]
    return {"step": number, "title": title, "mcp_tool": tool, "expected": expectation, **summary, **extra}


async def run_demo(container: Container) -> dict[str, Any]:
    container.agents.set_status(DEMO_AGENT_ID, "active")
    _, key = container.agents.rotate(DEMO_AGENT_ID, allow_system=True)
    seed_sandbox(container.sandbox)  # make sure sample files exist; never overwrites user edits
    server = build_mcp(container, env_key_resolver(key))
    steps: list[dict[str, Any]] = []

    async with create_connected_server_and_client_session(server._mcp_server) as client:
        listed = await client.list_tools()
        tool_names = sorted(t.name for t in listed.tools)

        # 1–2: receive the task and sanitize it.
        sanitized = _payload(await client.call_tool("sanitize_text", {"text": SAMPLE_TASK, "session_id": "demo"}))
        steps.append(_step(
            1, "Sanitize the incoming task", "sanitize_text", sanitized, "sanitized",
            sanitized_text=sanitized.get("sanitized_text"), entity_categories=sanitized.get("entity_categories"),
            redaction_count=sanitized.get("redaction_count"), redaction_session_id=sanitized.get("redaction_session_id"),
        ))
        sanitized_text = sanitized.get("sanitized_text", "")

        # 3: authorised sandbox read (output is sanitized too).
        read_ok = _payload(await client.call_tool(
            "execute_tool", {"tool_name": "read_file", "arguments": {"path": "notes/client-brief.txt"}, "session_id": "demo"}
        ))
        steps.append(_step(
            2, "Read a file inside the sandbox", "execute_tool", read_ok, "executed",
            output_preview=(read_ok.get("result", {}).get("content", "")[:240] or None),
        ))

        # 4: protected read outside the sandbox (path traversal) — must be denied.
        read_denied = _payload(await client.call_tool(
            "execute_tool", {"tool_name": "read_file", "arguments": {"path": "../vault.key"}}
        ))
        steps.append(_step(3, "Try to read the vault key via ../ traversal", "execute_tool", read_denied, "denied"))

        # 5: approval-required action — write to the outbox.
        write_args = {"path": "outbox/invoice-draft.txt", "content": sanitized_text + "\n", "mode": "overwrite"}
        pending = _payload(await client.call_tool("execute_tool", {"tool_name": "write_file", "arguments": write_args}))
        steps.append(_step(4, "Write the draft to the outbox", "execute_tool", pending, "approval_required"))
        request_id = pending.get("approval_request_id")

        # 6: approval flow.
        if request_id:
            container.gateway.decide_approval(request_id, True, DEMO_OPERATOR, channel="demo")
            collected = _payload(await client.call_tool("get_approval", {"approval_request_id": request_id}))
            token = collected.get("approval_token")
            steps.append({
                "step": 5, "title": "Operator approves; agent collects one-time token", "mcp_tool": "get_approval",
                "expected": "approved", "status": collected.get("status"), "approval_request_id": request_id,
                "token_received": bool(token), "message": collected.get("message"),
                "note": "Approval performed by the demo through the operator code path (labelled in Activity).",
            })
            executed = _payload(await client.call_tool(
                "execute_tool", {"tool_name": "write_file", "arguments": write_args, "approval_token": token}
            ))
            steps.append(_step(6, "Retry the write with the token", "execute_tool", executed, "executed"))
            replay = _payload(await client.call_tool(
                "execute_tool", {"tool_name": "write_file", "arguments": write_args, "approval_token": token}
            ))
            steps.append(_step(7, "Replay the same token", "execute_tool", replay, "approval_rejected"))

        unregistered = _payload(await client.call_tool(
            "execute_tool", {"tool_name": "run_shell", "arguments": {"cmd": "cat /etc/passwd"}}
        ))
        steps.append(_step(8, "Call an unregistered tool", "execute_tool", unregistered, "denied"))

    for step in steps:
        step["passed"] = step.get("status") == step["expected"]
    return {
        "agent_id": DEMO_AGENT_ID,
        "transport": "MCP (in-memory transport, same server code as stdio/HTTP)",
        "sample_task": "Contains a person name, an email address and a naira amount (not shown here).",
        "mcp_tools_listed": tool_names,
        "steps": steps,
        "all_passed": all(s["passed"] for s in steps),
    }


def reset_demo(container: Container, *, reset_policies: bool = False) -> dict[str, Any]:
    removed_events = container.audit.delete_demo()
    removed_approvals = container.approvals.delete_demo()
    session_ids = [
        r["id"] for r in container.main_db.query("SELECT id FROM redaction_sessions WHERE is_demo = 1")
    ]
    removed_mappings = container.privacy.vault.clear_sessions(session_ids)
    container.main_db.execute("DELETE FROM redaction_sessions WHERE is_demo = 1")
    draft = container.sandbox / "outbox" / "invoice-draft.txt"
    if draft.exists():
        draft.unlink()
    if reset_policies:
        container.policies.seed(reset=True)
    return {
        "removed_events": removed_events,
        "removed_approvals": removed_approvals,
        "removed_sessions": len(session_ids),
        "removed_mappings": removed_mappings,
        "policies_reset": reset_policies,
    }
