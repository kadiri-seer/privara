"""Example: an agent talking to Privara over MCP (stdio transport).

Run from the repository root after registering an agent in the dashboard:

    export PRIVARA_AGENT_KEY=pv_agent_...
    uv --directory backend run python ../examples/mcp_client.py

The script launches `privara mcp` as a subprocess (exactly what Claude Desktop or Cursor would do),
then sanitizes a message, checks a permission, reads a sandbox file and attempts a blocked read.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

BACKEND = Path(__file__).resolve().parents[1] / "backend"


def show(title: str, result) -> dict:
    payload = json.loads(result.content[0].text) if not result.isError else {"error": result.content[0].text}
    keep = {k: payload[k] for k in ("status", "decision", "sanitized_text", "explanation", "error", "redaction_session_id") if k in payload}
    print(f"\n{title}\n  " + json.dumps(keep, ensure_ascii=False, indent=2).replace("\n", "\n  "))
    return payload


async def main() -> int:
    key = os.environ.get("PRIVARA_AGENT_KEY")
    if not key:
        print("Set PRIVARA_AGENT_KEY to an agent key from the Agent Access page.", file=sys.stderr)
        return 2
    params = StdioServerParameters(
        command="uv",
        args=["--directory", str(BACKEND), "run", "privara", "mcp"],
        env={**os.environ, "PRIVARA_AGENT_KEY": key},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print("Privara tools:", ", ".join(sorted(t.name for t in tools.tools)))

            show("sanitize_text", await session.call_tool(
                "sanitize_text",
                {"text": "Send John Okafor the invoice for ₦250,000 at john@example.com.", "session_id": "example"},
            ))
            show("check_permission (outbox write)", await session.call_tool(
                "check_permission", {"action": "file.write", "resource": "sandbox:outbox/report.txt"}
            ))
            show("execute_tool read_file (inside sandbox)", await session.call_tool(
                "execute_tool", {"tool_name": "read_file", "arguments": {"path": "notes/welcome.txt"}}
            ))
            show("execute_tool read_file (traversal attempt)", await session.call_tool(
                "execute_tool", {"tool_name": "read_file", "arguments": {"path": "../vault.key"}}
            ))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
