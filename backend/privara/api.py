"""FastAPI application: agent REST API, operator (admin) API, MCP over HTTP and the dashboard."""

from __future__ import annotations

import logging
import os
import stat
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.routing import Route
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

from . import __version__
from .auth import LAB_AGENT_ID, Agent
from .config import Settings, get_settings
from .core import Container, build
from .demo import reset_demo, run_demo
from .errors import AuthenticationError, ForbiddenError, NotFoundError, PayloadTooLarge, PrivaraError, ValidationFailed
from .mcp_server import build_mcp, http_key_resolver
from .policy.engine import DECISIONS, KNOWN_ACTIONS, RESOURCE_SCHEMES
from .privacy.recognizers import ALL_CATEGORIES, CATEGORY_LABELS
from .security import bearer_from_header
from .throttle import AuthThrottle
from .tools.registry import describe_tools

log = logging.getLogger("privara.api")
SESSION_PATTERN = r"^[A-Za-z0-9_.:-]{1,64}$"


# ---------------------------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------------------------
class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Sensitivity(Strict):
    categories: list[str] | None = Field(default=None, max_length=20)
    level: Literal["low", "medium", "high"] | None = None
    threshold: float | None = Field(default=None, ge=0, le=1)


class SanitizeIn(Strict):
    text: str = Field(max_length=200_000)
    session_id: str = Field(default="default", pattern=SESSION_PATTERN)
    sensitivity: Sensitivity | None = None
    agent_id: str | None = Field(default=None, max_length=64)


class CheckPermissionIn(Strict):
    action: str = Field(min_length=1, max_length=64)
    resource: str = Field(min_length=1, max_length=256)
    context: dict[str, Any] | None = None
    agent_id: str | None = Field(default=None, max_length=64)


class ExecuteIn(Strict):
    tool_name: str = Field(min_length=1, max_length=64)
    arguments: dict[str, Any] = Field(default_factory=dict)
    approval_token: str | None = Field(default=None, max_length=200)
    session_id: str = Field(default="default", pattern=SESSION_PATTERN)
    sanitize_output: bool = True
    agent_id: str | None = Field(default=None, max_length=64)


class RestoreIn(Strict):
    text: str = Field(max_length=200_000)
    redaction_session_id: str = Field(min_length=1, max_length=64)
    approval_token: str | None = Field(default=None, max_length=200)
    agent_id: str | None = Field(default=None, max_length=64)


class AgentIn(Strict):
    name: str = Field(min_length=2, max_length=64)
    description: str = Field(default="", max_length=300)


class PolicyIn(Strict):
    name: str = Field(max_length=120)
    description: str = Field(default="", max_length=500)
    agent_id: str = Field(default="*", max_length=64)
    action: str = Field(max_length=64)
    resource: str = Field(max_length=256)
    decision: Literal["allow", "deny", "approval_required"]
    priority: int = Field(default=100, ge=0, le=10_000)
    enabled: bool = True


class PolicyPatch(Strict):
    name: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    agent_id: str | None = Field(default=None, max_length=64)
    action: str | None = Field(default=None, max_length=64)
    resource: str | None = Field(default=None, max_length=256)
    decision: Literal["allow", "deny", "approval_required"] | None = None
    priority: int | None = Field(default=None, ge=0, le=10_000)
    enabled: bool | None = None


class ExplainIn(Strict):
    agent_id: str = Field(default="*", max_length=64)
    action: str = Field(max_length=64)
    resource: str = Field(max_length=256)


class SettingsPatch(Strict):
    default_categories: list[str] | None = None
    detection_level: Literal["low", "medium", "high"] | None = None
    default_decision: Literal["deny", "approval_required"] | None = None
    audit_retention_days: int | None = None
    approval_ttl_seconds: int | None = None


class LabSanitizeIn(Strict):
    text: str = Field(max_length=200_000)
    session_id: str = Field(pattern=SESSION_PATTERN)
    sensitivity: Sensitivity | None = None


class LabRestoreIn(Strict):
    text: str = Field(max_length=200_000)
    redaction_session_id: str = Field(min_length=1, max_length=64)
    approval_request_id: str | None = Field(default=None, max_length=64)


class Confirm(Strict):
    confirm: bool = False


class DemoResetIn(Confirm):
    reset_policies: bool = False


def _require_confirm(body: Confirm) -> None:
    if not body.confirm:
        raise ValidationFailed("This is a destructive action. Send {\"confirm\": true} to proceed.", code="confirmation_required")


# ---------------------------------------------------------------------------------------------
# ASGI middleware
# ---------------------------------------------------------------------------------------------
class BodySizeLimit:
    """Reject request bodies above the limit, using Content-Length and by counting streamed bytes."""

    def __init__(self, app: ASGIApp, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    if int(value) > self.max_bytes:
                        await _too_large(send, self.max_bytes)
                        return
                except ValueError:
                    pass
        received = 0
        started = False

        async def limited_receive() -> dict:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise PayloadTooLarge(f"Request body exceeds {self.max_bytes} bytes.")
            return message

        async def tracking_send(message: dict) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except PayloadTooLarge:
            if not started:
                await _too_large(send, self.max_bytes)


async def _too_large(send: Send, limit: int) -> None:
    body = PayloadTooLarge(f"Request body exceeds {limit} bytes.").to_dict()
    import json

    raw = json.dumps(body).encode()
    await send({"type": "http.response.start", "status": 413,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(raw)).encode())]})
    await send({"type": "http.response.body", "body": raw})


class SecurityHeaders:
    CSP = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")

        async def with_headers(message: dict) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers += [
                    (b"x-content-type-options", b"nosniff"),
                    (b"x-frame-options", b"DENY"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"cache-control", b"no-store") if path.startswith(("/api", "/mcp")) else (b"x-privara", b"1"),
                ]
                if not path.startswith(("/api/docs", "/api/redoc")):
                    headers.append((b"content-security-policy", self.CSP.encode()))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, with_headers)


class MCPEndpoint:
    """Authenticates the bearer key before handing the request to the MCP session manager.
    Each tool call re-authenticates as well, so revocation is immediate even mid-session."""

    def __init__(self, container: Container, mcp, throttle: AuthThrottle):
        self.container = container
        self.mcp = mcp
        self.throttle = throttle

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        client = (scope.get("client") or ("unknown", 0))[0]
        try:
            self.throttle.check(client)
            try:
                self.container.agents.authenticate(bearer_from_header(headers.get("authorization")))
            except AuthenticationError:
                self.throttle.record_failure(client)
                raise
        except PrivaraError as exc:
            response = JSONResponse(exc.to_dict(), status_code=exc.status_code,
                                    headers={"www-authenticate": "Bearer"} if exc.status_code == 401 else None)
            await response(scope, receive, send)
            return
        await self.mcp.session_manager.handle_request(scope, receive, send)


# ---------------------------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------------------------
def configure_logging(level: str) -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger("privara")
    if not root.handlers:
        root.addHandler(handler)
    root.setLevel(level.upper())
    root.propagate = False
    # The MCP SDK logs every request at INFO; keep it quiet unless debugging.
    logging.getLogger("mcp").setLevel(logging.WARNING if level.upper() != "DEBUG" else logging.DEBUG)


def _file_info(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"path": str(path), "exists": False}
    st = path.stat()
    return {"path": str(path), "exists": True, "bytes": st.st_size, "mode": oct(stat.S_IMODE(st.st_mode))}


def create_app(settings: Settings | None = None, container: Container | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    if settings.is_hosted and settings.admin_api_key and len(settings.admin_api_key.get_secret_value()) < 32:
        raise SystemExit("PRIVARA_ADMIN_API_KEY must be at least 32 characters when PRIVARA_DEPLOYMENT=hosted.")
    container = container or build(settings)
    throttle = AuthThrottle(settings.auth_failures_per_minute)
    mcp = build_mcp(container, http_key_resolver, stateless_http=True, json_response=True) if settings.mcp_http_enabled else None
    if mcp is not None:
        mcp.streamable_http_app()  # initialises the session manager

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if mcp is not None:
            async with mcp.session_manager.run():
                yield
        else:
            yield

    app = FastAPI(
        title="Privara",
        version=__version__,
        summary="Your agents. Your boundaries. A local privacy and action firewall for AI agents.",
        description=(
            "Agent endpoints (`/api/v1/*`) authenticate with an agent key: `Authorization: Bearer pv_agent_…`.\n\n"
            "Operator endpoints (`/api/admin/*`) authenticate with an admin key: `Authorization: Bearer pv_admin_…`.\n\n"
            "Every error uses the shape `{\"error\": {\"code\", \"message\", \"details?\"}}`. Error messages never "
            "echo submitted values."
        ),
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    app.state.container = container
    allowed = settings.allowed_host_list
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed)

    # ---- error handling --------------------------------------------------------------------
    @app.exception_handler(PrivaraError)
    async def privara_error(_: Request, exc: PrivaraError):
        headers = {"www-authenticate": "Bearer"} if exc.status_code == 401 else None
        return JSONResponse(exc.to_dict(), status_code=exc.status_code, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        # Never echo the submitted input (FastAPI's default does), only locations and error types.
        details = [
            {"field": ".".join(str(p) for p in err.get("loc", []) if p != "body") or "(body)", "error": err.get("type")}
            for err in exc.errors()
        ]
        return JSONResponse(
            ValidationFailed("Request validation failed.", details=details).to_dict(), status_code=422
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException):
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        message = {404: "Not found.", 405: "Method not allowed."}.get(exc.status_code, "Request failed.")
        return JSONResponse({"error": {"code": code, "message": message}}, status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception):
        log.error("Unhandled error: %s", type(exc).__name__)  # no message: it could contain input
        return JSONResponse({"error": {"code": "internal_error", "message": "Internal error."}}, status_code=500)

    # ---- auth dependencies -----------------------------------------------------------------
    def throttled(request: Request, authenticate):
        client = request.client.host if request.client else "unknown"
        throttle.check(client)
        try:
            return authenticate(bearer_from_header(request.headers.get("authorization")))
        except AuthenticationError:
            throttle.record_failure(client)
            raise

    def agent_auth(request: Request) -> Agent:
        return throttled(request, container.agents.authenticate)

    def admin_auth(request: Request) -> str:
        return throttled(request, container.admin.authenticate)

    def check_claim(agent: Agent, claimed: str | None) -> None:
        if claimed and claimed not in (agent.id, agent.name):
            raise ForbiddenError("agent_id does not match the authenticated credential.", code="agent_mismatch")

    gw = container.gateway

    # ---- public ----------------------------------------------------------------------------
    def health_payload() -> dict[str, Any]:
        checks: dict[str, bool] = {}
        try:
            container.main_db.query_one("SELECT 1 AS ok")
            checks["database"] = True
        except Exception:
            checks["database"] = False
        try:
            container.vault_db.query_one("SELECT 1 AS ok")
            checks["vault"] = True
        except Exception:
            checks["vault"] = False
        checks["sandbox"] = container.sandbox.is_dir()
        detector = container.privacy.detector.describe()
        healthy = all(checks.values())
        return {
            "status": "ok" if healthy else "degraded",
            "version": __version__,
            "protection": "active" if healthy else "impaired",
            "checks": checks,
            "detector": {"mode": detector["mode"], "model": detector["model"], "fallback": bool(detector["fallback_reason"])},
            "default_decision": container.store.get("default_decision"),
            "mcp_http": settings.mcp_http_enabled,
            "deployment": settings.deployment,
        }

    @app.get("/api/health", tags=["public"])
    def health() -> dict[str, Any]:
        return health_payload()

    # ---- agent API -------------------------------------------------------------------------
    @app.post("/api/v1/sanitize", tags=["agent"])
    def sanitize(body: SanitizeIn, agent: Agent = Depends(agent_auth)) -> dict[str, Any]:
        check_claim(agent, body.agent_id)
        sens = body.sensitivity.model_dump(exclude_none=True) if body.sensitivity else None
        return gw.sanitize_text(agent, body.text, body.session_id, sens, channel="rest")

    @app.post("/api/v1/check-permission", tags=["agent"])
    def check_permission(body: CheckPermissionIn, agent: Agent = Depends(agent_auth)) -> dict[str, Any]:
        check_claim(agent, body.agent_id)
        return gw.check_permission(agent, body.action, body.resource, body.context, channel="rest")

    @app.post("/api/v1/execute", tags=["agent"])
    def execute(body: ExecuteIn, agent: Agent = Depends(agent_auth)) -> JSONResponse:
        check_claim(agent, body.agent_id)
        result = gw.execute_tool(
            agent, body.tool_name, body.arguments, body.approval_token, channel="rest",
            session_id=body.session_id, sanitize_output=body.sanitize_output,
        )
        status = {"executed": 200, "approval_required": 202, "denied": 403, "approval_rejected": 403, "failed": 422}
        return JSONResponse(result, status_code=status.get(result["status"], 200))

    @app.post("/api/v1/restore", tags=["agent"])
    def restore(body: RestoreIn, agent: Agent = Depends(agent_auth)) -> JSONResponse:
        check_claim(agent, body.agent_id)
        result = gw.restore_text(agent, body.text, body.redaction_session_id, body.approval_token, channel="rest")
        status = {"restored": 200, "approval_required": 202, "denied": 403, "approval_rejected": 403}
        return JSONResponse(result, status_code=status.get(result["status"], 200))

    @app.get("/api/v1/approvals/{request_id}", tags=["agent"])
    def agent_approval(request_id: str, agent: Agent = Depends(agent_auth)) -> dict[str, Any]:
        return gw.get_approval(agent, request_id)

    @app.get("/api/v1/tools", tags=["agent"])
    def tools(agent: Agent = Depends(agent_auth)) -> dict[str, Any]:
        return {"tools": describe_tools()}

    @app.get("/api/v1/whoami", tags=["agent"])
    def whoami(agent: Agent = Depends(agent_auth)) -> dict[str, Any]:
        return {"agent_id": agent.id, "name": agent.name, "status": agent.status}

    # ---- admin: overview -------------------------------------------------------------------
    @app.get("/api/admin/session", tags=["admin"])
    def admin_session(cred: str = Depends(admin_auth)) -> dict[str, Any]:
        return {"authenticated": True, "credential": cred}

    @app.get("/api/admin/overview", tags=["admin"])
    def overview(_: str = Depends(admin_auth)) -> dict[str, Any]:
        stats = container.audit.stats()
        agents = container.agents.list()
        return {
            "registered_agents": sum(1 for a in agents if not a["is_system"]),
            "active_agents": sum(1 for a in agents if not a["is_system"] and a["status"] == "active"),
            "redactions": stats["redactions"],
            "allowed": stats["allowed"],
            "blocked": stats["blocked"],
            "awaiting_approval": container.approvals.pending_count(),
            "events": stats["events"],
            "recent": container.audit.search(limit=8)["items"],
            "health": health_payload(),
        }

    # ---- admin: agents ---------------------------------------------------------------------
    @app.get("/api/admin/agents", tags=["admin"])
    def list_agents(_: str = Depends(admin_auth)) -> dict[str, Any]:
        return {"items": container.agents.list()}

    @app.post("/api/admin/agents", status_code=201, tags=["admin"])
    def create_agent(body: AgentIn, _: str = Depends(admin_auth)) -> dict[str, Any]:
        agent, key = container.agents.create(body.name, body.description)
        return {"agent": agent, "api_key": key, "notice": "Copy this key now. Privara stores only its hash."}

    @app.post("/api/admin/agents/{agent_id}/rotate", tags=["admin"])
    def rotate_agent(agent_id: str, _: str = Depends(admin_auth)) -> dict[str, Any]:
        agent, key = container.agents.rotate(agent_id)
        return {"agent": agent, "api_key": key, "notice": "The previous key stopped working immediately."}

    @app.post("/api/admin/agents/{agent_id}/revoke", tags=["admin"])
    def revoke_agent(agent_id: str, _: str = Depends(admin_auth)) -> dict[str, Any]:
        agent = container.agents.set_status(agent_id, "revoked")
        expired = container.approvals.expire_for_agent(agent_id)
        return {"agent": agent, "expired_approvals": expired}

    @app.post("/api/admin/agents/{agent_id}/reactivate", tags=["admin"])
    def reactivate_agent(agent_id: str, _: str = Depends(admin_auth)) -> dict[str, Any]:
        return {"agent": container.agents.set_status(agent_id, "active")}

    @app.get("/api/admin/agents/{agent_id}/scopes", tags=["admin"])
    def agent_scopes(agent_id: str, _: str = Depends(admin_auth)) -> dict[str, Any]:
        agent = container.agents.get(agent_id)
        last = container.audit.search(agent_id=agent_id, limit=1)["items"]
        return {
            "agent": agent,
            "policies": container.policies.effective_for_agent(agent_id),
            "default_decision": container.store.get("default_decision"),
            "last_activity": last[0] if last else None,
        }

    # ---- admin: policies -------------------------------------------------------------------
    @app.get("/api/admin/policies", tags=["admin"])
    def list_policies(_: str = Depends(admin_auth)) -> dict[str, Any]:
        return {
            "items": container.policies.list(),
            "actions": KNOWN_ACTIONS,
            "resource_schemes": RESOURCE_SCHEMES,
            "decisions": DECISIONS,
            "default_decision": container.store.get("default_decision"),
        }

    @app.post("/api/admin/policies", status_code=201, tags=["admin"])
    def create_policy(body: PolicyIn, _: str = Depends(admin_auth)) -> dict[str, Any]:
        return container.policies.create(body.model_dump())

    @app.patch("/api/admin/policies/{policy_id}", tags=["admin"])
    def update_policy(policy_id: str, body: PolicyPatch, _: str = Depends(admin_auth)) -> dict[str, Any]:
        return container.policies.update(policy_id, body.model_dump(exclude_none=True))

    @app.delete("/api/admin/policies/{policy_id}", tags=["admin"])
    def delete_policy(policy_id: str, _: str = Depends(admin_auth)) -> dict[str, Any]:
        container.policies.delete(policy_id)
        return {"deleted": policy_id}

    @app.post("/api/admin/policies/explain", tags=["admin"])
    def explain_policy(body: ExplainIn, _: str = Depends(admin_auth)) -> dict[str, Any]:
        agent_id = body.agent_id or "*"
        decision = container.policies.evaluate(agent_id, body.action, body.resource)
        return {
            "simulation": True,
            "note": "Simulation only — not recorded as an agent decision and nothing is executed.",
            "decision": decision.decision,
            "explanation": decision.explanation,
            "policy": decision.policy_ref(),
            "default_applied": decision.default_applied,
            "matches": [
                {k: p[k] for k in ("id", "name", "agent_id", "action", "resource", "decision", "priority")}
                for p in container.policies.matching(agent_id, body.action, body.resource)
            ],
        }

    # ---- admin: approvals ------------------------------------------------------------------
    @app.get("/api/admin/approvals", tags=["admin"])
    def list_approvals(status: str | None = None, _: str = Depends(admin_auth)) -> dict[str, Any]:
        return {"items": container.approvals.list(status)}

    @app.post("/api/admin/approvals/{request_id}/approve", tags=["admin"])
    def approve(request_id: str, cred: str = Depends(admin_auth)) -> dict[str, Any]:
        return gw.decide_approval(request_id, True, f"operator:{cred}")

    @app.post("/api/admin/approvals/{request_id}/deny", tags=["admin"])
    def deny(request_id: str, cred: str = Depends(admin_auth)) -> dict[str, Any]:
        return gw.decide_approval(request_id, False, f"operator:{cred}")

    # ---- admin: activity -------------------------------------------------------------------
    @app.get("/api/admin/activity", tags=["admin"])
    def activity(
        agent_id: str | None = None,
        action: str | None = None,
        decision: str | None = None,
        outcome: str | None = None,
        since: str | None = None,
        until: str | None = None,
        q: str | None = None,
        limit: int = 50,
        offset: int = 0,
        _: str = Depends(admin_auth),
    ) -> dict[str, Any]:
        if q is not None and len(q) > 100:
            raise ValidationFailed("Search text is limited to 100 characters.")
        return container.audit.search(
            agent_id=agent_id, action=action, decision=decision, outcome=outcome, since=since, until=until, q=q,
            limit=limit, offset=offset,
        )

    @app.get("/api/admin/activity/meta", tags=["admin"])
    def activity_meta(_: str = Depends(admin_auth)) -> dict[str, Any]:
        return {
            "agents": [{"id": a["id"], "name": a["name"]} for a in container.agents.list()],
            "actions": container.audit.distinct_actions(),
            "decisions": list(DECISIONS),
        }

    @app.get("/api/admin/activity/{event_id}", tags=["admin"])
    def activity_detail(event_id: str, _: str = Depends(admin_auth)) -> dict[str, Any]:
        event = container.audit.get(event_id)
        if not event:
            raise NotFoundError("Event not found.")
        approval = None
        if event.get("approval_request_id"):
            try:
                approval = container.approvals.get(event["approval_request_id"])
            except PrivaraError:
                approval = None
        return {"event": event, "approval": approval}

    # ---- admin: privacy lab ----------------------------------------------------------------
    @app.post("/api/admin/lab/sanitize", tags=["admin"])
    def lab_sanitize(body: LabSanitizeIn, _: str = Depends(admin_auth)) -> dict[str, Any]:
        lab = container.agents.require_active(LAB_AGENT_ID)
        sens = body.sensitivity.model_dump(exclude_none=True) if body.sensitivity else None
        return gw.sanitize_text(lab, body.text, body.session_id, sens, channel="lab", include_spans=True)

    @app.post("/api/admin/lab/restore", tags=["admin"])
    def lab_restore(body: LabRestoreIn, _: str = Depends(admin_auth)) -> dict[str, Any]:
        lab = container.agents.require_active(LAB_AGENT_ID)
        token = None
        if body.approval_request_id:
            collected = gw.get_approval(lab, body.approval_request_id)
            token = collected.get("approval_token")
            if not token:
                return {"status": "approval_" + collected["status"], "message": collected.get("message"),
                        "approval_request_id": body.approval_request_id}
        return gw.restore_text(lab, body.text, body.redaction_session_id, token, channel="lab")

    @app.get("/api/admin/sessions/{session_id}", tags=["admin"])
    def session_detail(session_id: str, _: str = Depends(admin_auth)) -> dict[str, Any]:
        return gw.session_info(session_id)

    @app.delete("/api/admin/sessions/{session_id}", tags=["admin"])
    def clear_session(session_id: str, _: str = Depends(admin_auth)) -> dict[str, Any]:
        return {"cleared_mappings": gw.clear_session(session_id)}

    @app.post("/api/admin/sessions/clear", tags=["admin"])
    def clear_sessions(body: Confirm, _: str = Depends(admin_auth)) -> dict[str, Any]:
        _require_confirm(body)
        return {"cleared_mappings": gw.clear_all_sessions()}

    # ---- admin: settings & storage ---------------------------------------------------------
    def storage_info() -> dict[str, Any]:
        counts = container.main_db.query_one(
            "SELECT (SELECT COUNT(*) FROM audit_events) AS audit_events,"
            " (SELECT COUNT(*) FROM redaction_sessions) AS redaction_sessions,"
            " (SELECT COUNT(*) FROM approval_requests) AS approval_requests,"
            " (SELECT COUNT(*) FROM policies) AS policies"
        )
        return {
            "data_dir": str(settings.data_dir.resolve()),
            "sandbox_dir": str(container.sandbox),
            "main_db": _file_info(settings.main_db_path),
            "vault_db": _file_info(settings.vault_db_path),
            "vault_key": _file_info(settings.vault_key_path),
            "counts": {**(counts or {}), "vault_mappings": container.privacy.vault.count()},
            "encryption": {
                "vault_values": "Encrypted with Fernet (AES-128-CBC + HMAC) using the local vault.key file.",
                "main_db": "Not encrypted at rest. Contains no original sensitive values by design.",
                "caveat": "The vault key sits on the same disk; anyone who can read the data directory can decrypt.",
            },
            "permissions_enforced": os.name == "posix",
        }

    @app.get("/api/admin/settings", tags=["admin"])
    def get_settings_route(_: str = Depends(admin_auth)) -> dict[str, Any]:
        return {
            "settings": container.store.all(),
            "categories": [{"id": c, "label": CATEGORY_LABELS[c]} for c in ALL_CATEGORIES],
            "storage": storage_info(),
            "limits": {
                "max_request_bytes": settings.max_request_bytes,
                "max_text_chars": settings.max_text_chars,
                "max_file_bytes": settings.max_file_bytes,
            },
        }

    @app.patch("/api/admin/settings", tags=["admin"])
    def patch_settings(body: SettingsPatch, _: str = Depends(admin_auth)) -> dict[str, Any]:
        return {"settings": container.store.update(body.model_dump(exclude_none=True))}

    @app.post("/api/admin/audit/purge", tags=["admin"])
    def purge_audit(body: Confirm, _: str = Depends(admin_auth)) -> dict[str, Any]:
        _require_confirm(body)
        return {"removed": container.audit.purge()}

    @app.post("/api/admin/audit/clear", tags=["admin"])
    def clear_audit(body: Confirm, _: str = Depends(admin_auth)) -> dict[str, Any]:
        _require_confirm(body)
        return {"removed": container.audit.clear_all()}

    @app.get("/api/admin/credentials", tags=["admin"])
    def credentials(_: str = Depends(admin_auth)) -> dict[str, Any]:
        return {"items": container.admin.list()}

    @app.post("/api/admin/credentials/rotate", tags=["admin"])
    def rotate_admin(body: Confirm, cred: str = Depends(admin_auth)) -> dict[str, Any]:
        _require_confirm(body)
        key = container.admin.rotate(cred)
        return {"api_key": key, "notice": "All other stored admin keys were revoked. Copy this key now."}

    # ---- admin: demo & integrations --------------------------------------------------------
    @app.post("/api/admin/demo/run", tags=["admin"])
    async def demo_run(_: str = Depends(admin_auth)) -> dict[str, Any]:
        return await run_demo(container)

    @app.post("/api/admin/demo/reset", tags=["admin"])
    def demo_reset(body: DemoResetIn, _: str = Depends(admin_auth)) -> dict[str, Any]:
        _require_confirm(body)
        return reset_demo(container, reset_policies=body.reset_policies)

    @app.get("/api/admin/integrations", tags=["admin"])
    def integrations(request: Request, _: str = Depends(admin_auth)) -> dict[str, Any]:
        base = str(request.base_url).rstrip("/")
        forwarded = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
        if settings.is_hosted and forwarded in allowed:
            base = f"https://{forwarded}"  # the address the browser used, e.g. a Vercel domain
        backend_dir = Path(__file__).resolve().parents[1]
        return {
            "actual": {
                "base_url": base,
                "rest_base": f"{base}/api/v1",
                "openapi": f"{base}/api/openapi.json",
                "docs": f"{base}/api/docs",
                "mcp_http": f"{base}/mcp" if settings.mcp_http_enabled else None,
                "mcp_stdio_command": None
                if settings.is_hosted
                else ["uv", "--directory", str(backend_dir), "run", "privara", "mcp"],
            },
            "tools": describe_tools(),
            "health": health_payload(),
        }

    # ---- MCP over HTTP ---------------------------------------------------------------------
    if mcp is not None:
        app.router.routes.append(Route("/mcp", endpoint=MCPEndpoint(container, mcp, throttle), methods=["GET", "POST", "DELETE"]))

    # ---- dashboard -------------------------------------------------------------------------
    dist = settings.frontend_dist
    if dist.is_dir() and (dist / "index.html").exists():
        if (dist / "assets").is_dir():
            app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str):
            if full_path.startswith(("api/", "mcp")):
                raise StarletteHTTPException(404)
            candidate = (dist / full_path).resolve()
            if full_path and candidate.is_file() and candidate.is_relative_to(dist.resolve()):
                return FileResponse(candidate)
            return FileResponse(dist / "index.html")

    # Outermost wrappers (added last so they run first).
    app.add_middleware(BodySizeLimit, max_bytes=settings.max_request_bytes)
    app.add_middleware(SecurityHeaders)
    return app
