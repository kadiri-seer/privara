# Connecting agents over MCP

Privara exposes one MCP server, reachable two ways. Both authenticate with an **agent key** from
**Agent Access** and run identical tool code.

| Transport | Endpoint | Key |
| --- | --- | --- |
| stdio | `uv --directory /path/to/privara/backend run privara mcp` | `PRIVARA_AGENT_KEY` environment variable |
| Streamable HTTP (stateless, JSON responses) | `http://127.0.0.1:8787/mcp` | `Authorization: Bearer <key>` header |

The server process must be able to read the same `PRIVARA_DATA_DIR` as the dashboard (the default
`./data` works when both run from this repository).

## Tools

| Tool | Arguments | Notes |
| --- | --- | --- |
| `sanitize_text` | `text`, `session_id?`, `sensitivity?`, `agent_id?` | Returns `sanitized_text`, `entity_categories`, `redaction_count`, `redaction_session_id`. |
| `check_permission` | `action`, `resource`, `context?`, `agent_id?` | Decision only: `allow`, `deny` or `approval_required`, with policy, explanation and `decision_id`. |
| `execute_tool` | `tool_name`, `arguments`, `approval_token?`, `session_id?`, `sanitize_output?`, `agent_id?` | Runs `read_file`, `write_file` or `transform_text` under policy. |
| `restore_text` | `text`, `redaction_session_id`, `approval_token?`, `agent_id?` | Owner-only; approval required by default. |
| `get_approval` | `approval_request_id`, `agent_id?` | Returns the one-time token after a human approves. |
| `list_tools` | — | Registered tools and argument schemas. |

`agent_id` is optional. Identity always comes from the key; if `agent_id` is passed and doesn't match,
the call is refused with `agent_mismatch`. Policy outcomes are returned as JSON with a `status` field;
authentication and validation problems come back as `{"status": "error", "error": {...}}`.

## Client configuration

**Claude Desktop / Claude Code / Cursor (stdio)** — see `examples/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "privara": {
      "command": "uv",
      "args": ["--directory", "/ABSOLUTE/PATH/TO/privara/backend", "run", "privara", "mcp"],
      "env": { "PRIVARA_AGENT_KEY": "pv_agent_…" }
    }
  }
}
```

**HTTP-capable clients:**

```json
{ "mcpServers": { "privara": { "type": "http", "url": "http://127.0.0.1:8787/mcp",
                               "headers": { "Authorization": "Bearer pv_agent_…" } } } }
```

## Python (official MCP SDK)

`examples/mcp_client.py` launches `privara mcp` over stdio and calls the tools. Run it with
`PRIVARA_AGENT_KEY=… uv --directory backend run python ../examples/mcp_client.py`.

## Agent frameworks

These snippets show the shape of the integration. They rely on third-party packages that are **not**
installed or tested in this repository.

**LangChain / LangGraph** (`pip install langchain-mcp-adapters`):

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "privara": {
        "transport": "streamable_http",
        "url": "http://127.0.0.1:8787/mcp",
        "headers": {"Authorization": "Bearer pv_agent_…"},
    }
})
tools = await client.get_tools()   # sanitize_text, execute_tool, … as LangChain tools
```

**OpenAI Agents SDK** (`pip install openai-agents`):

```python
from agents import Agent
from agents.mcp import MCPServerStreamableHttp

privara = MCPServerStreamableHttp(params={
    "url": "http://127.0.0.1:8787/mcp",
    "headers": {"Authorization": "Bearer pv_agent_…"},
})
async with privara:
    agent = Agent(name="assistant", mcp_servers=[privara],
                  instructions="Always call sanitize_text before sending user content anywhere.")
```

## Making the gateway meaningful

Privara can only enforce what passes through it. When you wire up an agent:

1. Remove the agent's own file-system, shell and HTTP tools for anything Privara should govern; give it
   Privara's `execute_tool` instead.
2. Point the sandbox (`PRIVARA_SANDBOX_DIR`) at the only folder the agent should work in.
3. Instruct the agent (the MCP server's `instructions` already do this) to call `sanitize_text` before
   sending user content to any model or tool, and to handle `approval_required` by asking a human.
4. Give each agent its own key so policies, revocation and the audit trail are per agent.
