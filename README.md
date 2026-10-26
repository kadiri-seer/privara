# Privara

**Your agents. Your boundaries.**

Privara is a local, open-source privacy and action firewall for AI agents. Agents connect to it over
**MCP** or **REST**, and Privara:

1. **Protects privacy** — detects personal and financial details (names, emails, phone numbers, amounts,
   card numbers, IDs, locations…) with Microsoft Presidio, replaces them with deterministic placeholders
   such as `[PERSON_1]`, keeps the reversible mapping encrypted on your machine, and restores originals
   only for the owning agent and only when policy (by default, a human approval) allows it.
2. **Protects actions** — every tool call is evaluated against policies stored in SQLite and is allowed,
   denied, or held for approval. Approvals produce one-time, expiring tokens bound to the exact action
   and arguments. Only tools compiled into Privara can run, and file tools are confined to a sandbox.

Everything runs locally: no paid APIs, no cloud account, no LLM required.

```
 Agent (Claude Desktop, Cursor, your code)
   │  MCP (stdio or HTTP)  /  REST
   ▼
 ┌──────────────── Privara gateway (127.0.0.1) ────────────────┐
 │ auth (per-agent keys) → policy engine → approvals → tools    │
 │ privacy engine (Presidio + spaCy) ↔ encrypted vault          │
 │ audit log (no raw values)                                    │
 └──────────────────────────────────────────────────────────────┘
   ▼
 sandbox directory (the only files agents can touch)
```

## Quick start

Requirements: [uv](https://docs.astral.sh/uv/) (fetches Python 3.12 if needed) and Node.js 20+.

```bash
./start.sh
```

On first run this installs pinned dependencies, builds the dashboard, initialises `./data`, prints an
**admin key once**, and serves everything at <http://127.0.0.1:8787>. Paste the admin key into the
sign-in screen. Lost it? `uv --directory backend run privara admin-key` issues a new one.

Then, in the dashboard: **Overview → Run the demo** to watch a built-in agent exercise every rule over
MCP, and **Privacy Lab** to sanitize your own text.

<details>
<summary>Manual setup (without start.sh, e.g. on Windows)</summary>

```bash
cd backend && uv sync --frozen --extra nlp && cd ..
cd frontend && npm ci && npm run build && cd ..
uv --directory backend run privara init
uv --directory backend run privara serve
```

Frontend development with hot reload: run `privara serve`, then `npm run dev` in `frontend/`
(Vite proxies `/api` and `/mcp` to port 8787) and open <http://127.0.0.1:5173>.
</details>

## Connecting an agent

1. **Agent Access → Register agent**. Copy the key (shown once; only its hash is stored).
2. Connect with one of:

| Transport | How |
| --- | --- |
| MCP over stdio | Add `examples/claude_desktop_config.json` to your client, with the absolute path to `backend/` and the agent key. |
| MCP over HTTP | `http://127.0.0.1:8787/mcp` with header `Authorization: Bearer <agent key>` (streamable HTTP, stateless). |
| REST | `http://127.0.0.1:8787/api/v1/*` with the same header. OpenAPI docs at `/api/docs`. |

MCP tools: `sanitize_text`, `check_permission`, `execute_tool`, `restore_text`, plus `get_approval`
(collect a one-time token) and `list_tools`. Registered tools for `execute_tool`: `read_file`,
`write_file`, `transform_text`.

See [docs/MCP.md](docs/MCP.md) for client configuration and agent-framework integration (Claude
Desktop, Cursor, LangChain, OpenAI Agents SDK, plain Python), and [docs/API.md](docs/API.md) for REST
requests and responses. `examples/mcp_client.py` and `examples/rest_examples.sh` are runnable.

### The approval flow

```
agent → execute_tool(write_file, outbox/…)         ← 202 approval_required + approval_request_id
human → Approve (dashboard Overview / Activity)
agent → get_approval(approval_request_id)          ← approval_token (returned exactly once)
agent → execute_tool(same args, approval_token)    ← executed; token consumed
agent → execute_tool(same args, same token)        ← approval_rejected: token_reused
```

Tokens expire (default 5 minutes after approval), are bound to the agent, action, resource and the
canonical arguments, and are stored only as hashes.

## Built-in policies

| Policy | Decision |
| --- | --- |
| Unregistered tools | deny (also hard-enforced by the registry) |
| Reading / writing outside the sandbox | deny (also hard-enforced by the tool) |
| Writing to `sandbox:protected/*` | deny |
| Writing to `sandbox:outbox/*` | approval required |
| Restoring sensitive values | approval required |
| Reading / writing inside the sandbox, text transforms, sanitizing | allow |
| Anything unmatched | deny (configurable to approval required — never allow) |

Evaluation: highest priority first, then agent-specific before any-agent, exact action before wildcard,
stricter decision first. The first enabled match wins. Use **Policies → Explain a decision** to simulate.

## Configuration

All settings are environment variables (or `.env` in the repo root); see [.env.example](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRIVARA_HOST` / `PRIVARA_PORT` | `127.0.0.1` / `8787` | Bind address. Non-loopback requires `serve --allow-remote`. |
| `PRIVARA_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Accepted `Host` headers (DNS-rebinding defence). |
| `PRIVARA_DATA_DIR` | `./data` | Databases, vault key and default sandbox. |
| `PRIVARA_SANDBOX_DIR` | `<data>/sandbox` | The only directory file tools can access. |
| `PRIVARA_ADMIN_API_KEY` | unset | Optional bootstrap admin key (kept only as an in-memory hash). |
| `PRIVARA_AGENT_KEY` | unset | Agent key for `privara mcp` (stdio). |
| `PRIVARA_NLP_ENABLED` / `PRIVARA_NLP_MODEL` | `true` / `en_core_web_sm` | spaCy NER model. If it can't load, Privara falls back to pattern-only detection and says so in the UI and `/api/health`. |
| `PRIVARA_MAX_REQUEST_BYTES` | `262144` | Request body limit (413 above it). |
| `PRIVARA_MAX_TEXT_CHARS` | `50000` | Max text length for sanitize/restore. |
| `PRIVARA_MAX_FILE_BYTES` | `1048576` | Max file size for sandbox reads/writes. |
| `PRIVARA_APPROVAL_TTL_SECONDS` | `300` | Token lifetime after approval (also editable in Settings). |
| `PRIVARA_PENDING_APPROVAL_TTL_SECONDS` | `3600` | How long a request can wait for a decision. |
| `PRIVARA_MCP_HTTP_ENABLED` | `true` | Serve MCP at `/mcp`. |
| `PRIVARA_LOG_LEVEL` | `INFO` | Logs never include request bodies, values or keys. |

## CLI

```
privara init [--new-admin-key]   create databases, seed policies, print an admin key on first run
privara serve [--host --port]    REST API, MCP over HTTP and the dashboard
privara mcp                      MCP over stdio (needs PRIVARA_AGENT_KEY)
privara demo                     run the demo agent from the terminal (exit code 1 if any step misbehaves)
privara create-agent NAME        register an agent and print its key once
privara admin-key                rotate the admin key
```

Run them with `uv --directory backend run privara …`.

## Repository layout

```
backend/privara/
  privacy/      Presidio detection, custom recognizers (₦/NGN amounts, Nigerian phones, NIN/BVN), vault
  policy/       policy storage, validation, evaluation and seeds
  tools/        the fixed tool registry and sandbox enforcement
  gateway.py    the single code path used by MCP, REST, Privacy Lab and the demo
  approvals.py  one-time, expiring, action-bound approval tokens
  audit.py      privacy-preserving activity log
  mcp_server.py MCP server (stdio, HTTP, in-memory)
  api.py        FastAPI app, middleware, error format, dashboard hosting
  demo.py       built-in demo agent
backend/tests/  93 tests: privacy, policy, gateway security, REST, MCP
frontend/       React + TypeScript + Vite + Tailwind dashboard (vitest tests in src/__tests__)
docs/           THREAT_MODEL.md, API.md, MCP.md
examples/       MCP client, client config, REST walkthrough
```

## Tests

```bash
uv --directory backend run pytest          # backend: 93 tests
cd frontend && npm test && npx tsc -b      # dashboard: 9 interaction tests + type check
```

Covered: deterministic redaction and placeholder reuse, session isolation, fallback detection,
authorized and unauthorized restoration, placeholder-injection on restore, seeded and custom policy
decisions, precedence, default-deny, approval flow, expired / reused / substituted / cross-agent tokens,
revocation (including mid-MCP-session), key rotation, path traversal (`../`, absolute, `~`, Windows
paths, symlink escape), the tool refusing outside paths even under an allow policy, unregistered tools,
authentication failures, request size limits, Host-header checks, validation errors not echoing input,
audit-log / database / log scans for leaked values, MCP over in-memory transport and over HTTP, REST
status codes, demo run and reset, and persistence across restarts.

## Manual end-to-end check

1. `./start.sh`; sign in with the printed admin key. The sidebar shows **Protection active**.
2. **Overview → Run the demo.** All 8 steps read “as expected”; numbers update.
3. **Privacy Lab → Use sample text → Sanitize.** Veiled placeholders appear; originals are highlighted.
   **Request restore → Approve and restore** shows the original text; **Hide originals** re-veils it.
4. **Agent Access → Register agent**; copy the key. Run
   `PRIVARA_AGENT_KEY=… uv --directory backend run python ../examples/mcp_client.py`.
5. **Policies → New policy** denying that agent `file.read` on `sandbox:notes/*`. Re-run the client:
   the in-sandbox read is now denied by your policy.
6. **Agent Access → Revoke access**; re-run the client: it fails with `agent_revoked`.
7. **Activity**: filter by *Deny*, open an event — it shows the decision, that nothing ran, and why.
8. Stop the server, start it again: all agents, policies and events are still there.
9. **Settings → Reset demo data**: demo events disappear; your policies remain.

## Limitations (honest list)

- **Detection is probabilistic.** The default `en_core_web_sm` model misses some names (especially
  non-Western ones) and occasionally tags ordinary words. “Catch more” sensitivity adds a capitalised-name
  heuristic; a larger model (`uv pip install` the `en_core_web_lg` wheel and set `PRIVARA_NLP_MODEL`)
  improves recall. Never treat redaction as a guarantee.
- **The gateway only protects what goes through it.** An agent with its own file system, shell or network
  access can bypass Privara entirely. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
- **Encryption at rest is partial.** Vault values are encrypted with a key stored next to the database;
  the main database (audit, policies) is not encrypted, by design contains no original values, and relies
  on owner-only file permissions (POSIX).
- **Single operator.** One admin role; no multi-user accounts or per-operator permissions.
- **No rate limiting** of failed authentication attempts (keys carry 256 bits of entropy).
- **Sandbox races.** Paths are resolved and opened with `O_NOFOLLOW`, but a local process racing to swap
  directories for symlinks between check and open is out of scope.
- **`restore_text` only restores placeholders from the agent’s own session**; values in a different
  session cannot be cross-restored, which is intentional.
- The optional Ollama adapter mentioned in the brief is **not implemented**; no core feature needs an LLM.
- The dashboard keeps the admin key in `sessionStorage` for the tab’s lifetime.

## License

Apache-2.0.
