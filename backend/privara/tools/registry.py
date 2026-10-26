"""The fixed registry of tools the gateway can execute.

The registry is defined in code and cannot be extended at runtime through MCP or REST. Every
tool validates its arguments with a Pydantic model, maps the call to an (action, resource) pair
for the policy engine, and enforces its own hard limits (sandbox confinement, size caps)
independently of policy — so even a mistakenly permissive policy cannot escape the sandbox.
"""

from __future__ import annotations

import hashlib
import os
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ..errors import PrivaraError, ValidationFailed


class ToolExecutionError(PrivaraError):
    status_code = 400
    code = "tool_error"


class StrictArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class ReadFileArgs(StrictArgs):
    path: str = Field(min_length=1, max_length=512, description="Path relative to the sandbox directory.")

    @field_validator("path")
    @classmethod
    def no_nul(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("path must not contain NUL bytes")
        return value


class WriteFileArgs(ReadFileArgs):
    content: str = Field(max_length=200_000)
    mode: Literal["create", "overwrite", "append"] = "create"


class TransformTextArgs(StrictArgs):
    operation: Literal["uppercase", "lowercase", "titlecase", "word_count", "char_count", "sha256", "slugify", "reverse"]
    text: str = Field(max_length=50_000)


@dataclass(frozen=True)
class ResolvedPath:
    inside: bool
    relative: str  # path relative to the sandbox (normalised), or the raw request if outside
    absolute: Path | None


def resolve_in_sandbox(sandbox: Path, requested: str) -> ResolvedPath:
    """Resolve ``requested`` against the sandbox, following symlinks. Absolute paths, drive
    letters, ``..`` traversal and symlinks that point elsewhere all resolve as outside."""
    sandbox = sandbox.resolve()
    cleaned = requested.replace("\\", "/")
    if cleaned.startswith("/") or re.match(r"^[A-Za-z]:", cleaned) or cleaned.startswith("~"):
        return ResolvedPath(False, _display(cleaned), None)
    candidate = (sandbox / cleaned).resolve()
    try:
        relative = candidate.relative_to(sandbox)
    except ValueError:
        return ResolvedPath(False, _display(cleaned), None)
    rel = relative.as_posix()
    if rel in ("", "."):
        return ResolvedPath(True, ".", candidate)
    return ResolvedPath(True, rel, candidate)


def _display(raw: str) -> str:
    return raw[:200]


@dataclass(frozen=True)
class ToolContext:
    sandbox: Path
    max_file_bytes: int


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    action: str
    args_model: type[StrictArgs]
    resource: Callable[[Any, ToolContext], str]
    run: Callable[[Any, ToolContext], dict[str, Any]]
    sanitizable_output: str | None = None  # result key holding free text that may be sanitized

    def schema(self) -> dict[str, Any]:
        return self.args_model.model_json_schema()


def _path_resource(args: ReadFileArgs, ctx: ToolContext) -> str:
    resolved = resolve_in_sandbox(ctx.sandbox, args.path)
    return f"sandbox:{resolved.relative}" if resolved.inside else f"outside:{resolved.relative}"


def _require_inside(args: ReadFileArgs, ctx: ToolContext) -> Path:
    resolved = resolve_in_sandbox(ctx.sandbox, args.path)
    if not resolved.inside or resolved.absolute is None:
        raise ToolExecutionError("Path is outside the sandbox; the tool refuses it regardless of policy.", code="sandbox_violation")
    if resolved.relative == ".":
        raise ToolExecutionError("The sandbox root itself is not a file.", code="not_a_file")
    return resolved.absolute


def _read_file(args: ReadFileArgs, ctx: ToolContext) -> dict[str, Any]:
    path = _require_inside(args, ctx)
    if not path.exists():
        raise ToolExecutionError("File does not exist.", code="file_not_found")
    if not path.is_file():
        raise ToolExecutionError("Path is not a regular file.", code="not_a_file")
    size = path.stat().st_size
    if size > ctx.max_file_bytes:
        raise ToolExecutionError("File exceeds the maximum readable size.", code="file_too_large")
    # O_NOFOLLOW on the final component narrows the symlink-swap window after resolution.
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as handle:
        data = handle.read(ctx.max_file_bytes + 1)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ToolExecutionError("Only UTF-8 text files can be read.", code="not_text") from exc
    return {"path": path.relative_to(ctx.sandbox.resolve()).as_posix(), "bytes": len(data), "content": text}


def _write_file(args: WriteFileArgs, ctx: ToolContext) -> dict[str, Any]:
    path = _require_inside(args, ctx)
    payload = args.content.encode("utf-8")
    if len(payload) > ctx.max_file_bytes:
        raise ToolExecutionError("Content exceeds the maximum file size.", code="file_too_large")
    if path.exists() and not path.is_file():
        raise ToolExecutionError("Path is not a regular file.", code="not_a_file")
    if args.mode == "create" and path.exists():
        raise ToolExecutionError("File already exists; use mode 'overwrite' or 'append'.", code="file_exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    # Re-check after mkdir in case a parent was a symlink created concurrently.
    if resolve_in_sandbox(ctx.sandbox, args.path).absolute != path:
        raise ToolExecutionError("Path changed during write.", code="sandbox_violation")
    flags = os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    flags |= os.O_APPEND if args.mode == "append" else os.O_TRUNC
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(payload)
    return {
        "path": path.relative_to(ctx.sandbox.resolve()).as_posix(),
        "bytes_written": len(payload),
        "mode": args.mode,
    }


def _slugify(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


def _transform(args: TransformTextArgs, ctx: ToolContext) -> dict[str, Any]:
    ops: dict[str, Callable[[str], Any]] = {
        "uppercase": str.upper,
        "lowercase": str.lower,
        "titlecase": str.title,
        "word_count": lambda t: len(t.split()),
        "char_count": len,
        "sha256": lambda t: hashlib.sha256(t.encode("utf-8")).hexdigest(),
        "slugify": _slugify,
        "reverse": lambda t: t[::-1],
    }
    return {"operation": args.operation, "output": ops[args.operation](args.text)}


TOOLS: dict[str, ToolSpec] = {
    "read_file": ToolSpec(
        name="read_file",
        description="Read a UTF-8 text file from the sandbox directory. Output is sanitized by default.",
        action="file.read",
        args_model=ReadFileArgs,
        resource=_path_resource,
        run=_read_file,
        sanitizable_output="content",
    ),
    "write_file": ToolSpec(
        name="write_file",
        description="Create, overwrite or append to a text file inside the sandbox directory.",
        action="file.write",
        args_model=WriteFileArgs,
        resource=_path_resource,
        run=_write_file,
    ),
    "transform_text": ToolSpec(
        name="transform_text",
        description="Apply a pure text transformation (case, counts, sha256, slugify, reverse).",
        action="text.transform",
        args_model=TransformTextArgs,
        resource=lambda args, ctx: "builtin:transform_text",
        run=_transform,
        sanitizable_output="output",
    ),
}


def validate_args(tool: ToolSpec, arguments: dict[str, Any]) -> StrictArgs:
    try:
        return tool.args_model.model_validate(arguments)
    except ValidationError as exc:
        # Report field names and error types only — never the offending values.
        details = [
            {"field": ".".join(str(p) for p in err["loc"]) or "(root)", "error": err["type"]}
            for err in exc.errors(include_input=False, include_url=False)
        ]
        raise ValidationFailed("Tool arguments failed validation.", code="invalid_arguments", details=details) from None


def describe_tools() -> list[dict[str, Any]]:
    return [
        {"name": t.name, "description": t.description, "action": t.action, "input_schema": t.schema()}
        for t in TOOLS.values()
    ]
