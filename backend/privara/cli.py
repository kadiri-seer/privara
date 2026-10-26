"""Command-line entry point: ``privara <command>``."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from .config import get_settings


def _container():
    from .core import build

    return build(get_settings())


def cmd_init(args: argparse.Namespace) -> int:
    settings = get_settings()
    container = _container()
    print(f"Privara data directory: {settings.data_dir.resolve()}", file=sys.stderr)
    print(f"Sandbox directory:      {settings.sandbox_path}", file=sys.stderr)
    detector = container.privacy.detector.describe()
    print(f"PII detection:          {detector['mode']} ({detector['model'] or detector['fallback_reason']})", file=sys.stderr)
    if container.admin.has_any() and not args.new_admin_key:
        print("Admin credential:       already configured (use `privara admin-key` to rotate).", file=sys.stderr)
        return 0
    key = container.admin.create("initial") if not args.new_admin_key else container.admin.rotate(None)
    print("\n  Admin API key (shown once — paste it into the dashboard sign-in):\n", file=sys.stderr)
    print(f"  {key}\n", file=sys.stderr)
    return 0


def cmd_admin_key(_: argparse.Namespace) -> int:
    container = _container()
    key = container.admin.rotate(None, label="cli-rotation")
    print("New admin API key (all previous stored admin keys are revoked):\n", file=sys.stderr)
    print(key)
    return 0


def cmd_create_agent(args: argparse.Namespace) -> int:
    container = _container()
    agent, key = container.agents.create(args.name, args.description or "")
    print(f"Registered agent {agent['name']} ({agent['id']}). Key (shown once):", file=sys.stderr)
    print(key)
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .api import create_app

    settings = get_settings()
    host = args.host or settings.host
    if host not in ("127.0.0.1", "localhost", "::1") and not args.allow_remote:
        print("Refusing to bind to a non-loopback address without --allow-remote.", file=sys.stderr)
        return 2
    uvicorn.run(create_app(settings), host=host, port=args.port or settings.port, log_level=settings.log_level.lower())
    return 0


def cmd_mcp(_: argparse.Namespace) -> int:
    from .api import configure_logging
    from .mcp_server import run_stdio

    settings = get_settings()
    configure_logging(settings.log_level)
    key = settings.agent_key.get_secret_value() if settings.agent_key else None
    run_stdio(_container(), key)
    return 0


def cmd_demo(_: argparse.Namespace) -> int:
    from .demo import run_demo

    result = asyncio.run(run_demo(_container()))
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["all_passed"] else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="privara", description="Privara privacy and action firewall for AI agents")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init", help="Create databases, seed policies and print an admin key on first run")
    p.add_argument("--new-admin-key", action="store_true", help="Issue a new admin key and revoke stored ones")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("serve", help="Run the REST API, MCP HTTP endpoint and dashboard")
    p.add_argument("--host")
    p.add_argument("--port", type=int)
    p.add_argument("--allow-remote", action="store_true", help="Permit binding to a non-loopback address")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("mcp", help="Run the MCP server over stdio (requires PRIVARA_AGENT_KEY)")
    p.set_defaults(func=cmd_mcp)

    p = sub.add_parser("demo", help="Run the built-in demo agent against the gateway")
    p.set_defaults(func=cmd_demo)

    p = sub.add_parser("admin-key", help="Rotate the admin API key (prints the new key once)")
    p.set_defaults(func=cmd_admin_key)

    p = sub.add_parser("create-agent", help="Register an agent and print its key once")
    p.add_argument("name")
    p.add_argument("--description")
    p.set_defaults(func=cmd_create_agent)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
