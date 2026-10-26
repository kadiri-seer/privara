"""MCP server exposing the gateway to agents.

Identity is resolved from a credential on *every* tool call, never from tool arguments:

* stdio transport — the key comes from ``PRIVARA_AGENT_KEY`` in the server process environment.
* streamable HTTP — the key comes from the ``Authorization: Bearer`` header of each request.
* in-memory (demo/tests) — the key is supplied by the caller that builds the server.

The optional ``agent_id`` tool argument exists for clients that like to pass it explicitly;
if present it must match the authenticated agent, otherwise the call is refused.
"""

from typing import Any, Callable

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from pydantic import ValidationError

from .auth import Agent
from .core import Container
from .errors import ForbiddenError, PrivaraError
from .security import bearer_from_header
from .tools.registry import describe_tools

KeyResolver = Callable[[Context], str | None]

INSTRUCTIONS = (
    "Privara is a privacy and action firewall. Call sanitize_text before sending user content to any "
    "external model or tool. Use execute_tool for file and text operations; never access files directly. "
    "If a call returns status 'approval_required', ask the human to approve it in the Privara dashboard, "
    "then call get_approval to collect the one-time token and repeat the identical call with approval_token."
)


class PrivaraFastMCP(FastMCP):
    """FastMCP whose argument-validation errors never echo submitted values.

    The SDK's default error text embeds ``input_value=...`` from Pydantic, which could contain the
    very data Privara is meant to protect. We replace it with field names and error types only.
    """

    async def call_tool(self, name: str, arguments: dict[str, Any]):
        try:
            return await super().call_tool(name, arguments)
        except Exception as exc:
            cause = exc.__cause__
            if isinstance(cause, ValidationError):
                fields = ", ".join(
                    f"{'.'.join(str(p) for p in err['loc'])} ({err['type']})"
                    for err in cause.errors(include_input=False, include_url=False)
                )
                raise ToolError(f"Invalid arguments for tool '{name[:64]}': {fields}") from None
            if isinstance(exc, ToolError) and str(exc).startswith("Unknown tool"):
                raise ToolError(f"Unknown MCP tool '{name[:64]}'.") from None
            raise ToolError(f"Tool '{name[:64]}' failed with {type(cause or exc).__name__}.") from None


def env_key_resolver(key: str | None) -> KeyResolver:
    return lambda ctx: key


def http_key_resolver(ctx: Context) -> str | None:
    request = getattr(ctx.request_context, "request", None)
    if request is None:
        return None
    return bearer_from_header(request.headers.get("authorization"))


def build_mcp(container: Container, resolve_key: KeyResolver, *, channel: str = "mcp", **settings: Any) -> FastMCP:
    gateway = container.gateway
    mcp = PrivaraFastMCP("Privara", instructions=INSTRUCTIONS, **settings)

    def identify(ctx: Context, claimed_agent_id: str | None) -> Agent:
        agent = container.agents.authenticate(resolve_key(ctx))
        if claimed_agent_id and claimed_agent_id not in (agent.id, agent.name):
            raise ForbiddenError("agent_id does not match the authenticated credential.", code="agent_mismatch")
        return agent

    def run(fn: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        try:
            return fn()
        except PrivaraError as exc:
            # Return a structured error instead of raising so messages stay controlled and value-free.
            return {"status": "error", **exc.to_dict()}

    @mcp.tool(description="Detect and redact sensitive values. Returns sanitized text with deterministic placeholders such as [PERSON_1], plus a redaction_session_id needed for authorised restoration.")
    def sanitize_text(
        ctx: Context,
        text: str,
        session_id: str = "default",
        sensitivity: dict[str, Any] | None = None,
        agent_id: str | None = None,
    ) -> dict[str, Any]:
        return run(lambda: gateway.sanitize_text(identify(ctx, agent_id), text, session_id, sensitivity, channel=channel))

    @mcp.tool(description="Ask whether an action on a resource would be allowed, denied or require approval. Returns the matching policy, an explanation and a decision_id. Nothing is executed.")
    def check_permission(
        ctx: Context,
        action: str,
        resource: str,
        context: dict[str, Any] | None = None,
        agent_id: str | None = None,
    ) -> dict[str, Any]:
        return run(lambda: gateway.check_permission(identify(ctx, agent_id), action, resource, context, channel=channel))

    @mcp.tool(description="Execute a registered tool (read_file, write_file, transform_text) through policy enforcement. Pass approval_token only when retrying an approved request with identical arguments.")
    def execute_tool(
        ctx: Context,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
        approval_token: str | None = None,
        session_id: str = "default",
        sanitize_output: bool = True,
        agent_id: str | None = None,
    ) -> dict[str, Any]:
        return run(
            lambda: gateway.execute_tool(
                identify(ctx, agent_id), tool_name, arguments, approval_token, channel=channel,
                session_id=session_id, sanitize_output=sanitize_output,
            )
        )

    @mcp.tool(description="Restore original values in sanitized text for a redaction session you own. Usually requires a one-time approval token.")
    def restore_text(
        ctx: Context,
        text: str,
        redaction_session_id: str,
        approval_token: str | None = None,
        agent_id: str | None = None,
    ) -> dict[str, Any]:
        return run(
            lambda: gateway.restore_text(identify(ctx, agent_id), text, redaction_session_id, approval_token, channel=channel)
        )

    @mcp.tool(description="Check an approval request you created. Once a human approves it, the one-time approval_token is returned exactly once.")
    def get_approval(ctx: Context, approval_request_id: str, agent_id: str | None = None) -> dict[str, Any]:
        return run(lambda: gateway.get_approval(identify(ctx, agent_id), approval_request_id))

    @mcp.tool(description="List the tools the gateway can execute, with their argument schemas.")
    def list_tools(ctx: Context, agent_id: str | None = None) -> dict[str, Any]:
        return run(lambda: (identify(ctx, agent_id), {"tools": describe_tools()})[1])

    return mcp


def run_stdio(container: Container, key: str | None) -> None:
    if not key:
        raise SystemExit("PRIVARA_AGENT_KEY is not set. Register an agent in the dashboard and export its key.")
    # Fail fast with a clear message if the key is wrong or revoked.
    container.agents.authenticate(key)
    build_mcp(container, env_key_resolver(key)).run("stdio")
