# Privara threat model

## What Privara is for

Privara sits between an AI agent and (a) the external models and tools it sends data to, and (b) the
local actions it wants to take. It reduces two risks:

- **Data exposure** — personal or financial details leaving the machine inside prompts or tool calls.
- **Unsafe actions** — an agent (confused, prompt-injected, or buggy) reading or writing things it
  shouldn't, or acting without a human in the loop for sensitive operations.

## Assets

| Asset | Where | Protection |
| --- | --- | --- |
| Original sensitive values | `vault.db` | Fernet-encrypted; only decrypted inside an authorized `restore_text`. |
| Vault key | `vault.key` | Created with mode 0600; never sent over the API. |
| Agent / admin keys | `privara.db` | SHA-256 digests only; shown once at creation; constant-time comparison. |
| Approval tokens | `privara.db` | Digests only; minted when the agent collects them; single use; expiring. |
| Audit log | `privara.db` | Whitelisted metadata only (ids, actions, scopes, decisions, counts, categories). |
| Sandbox files | `data/sandbox` | Only reachable through the three registered tools. |

## Trust boundaries

1. **MCP server and REST API** — the security boundary. Every request is authenticated by key, identity
   is never taken from request arguments, agent status is read from the database on every call
   (revocation is immediate, including mid-MCP-session), and every decision is enforced in backend code.
2. **Dashboard / operator API** — authenticated with a separate admin key. Admin and agent keys are not
   interchangeable.
3. **Sandbox directory** — file tools resolve paths (following symlinks) and refuse anything outside,
   independent of policy.

## Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Agent reads secrets via `../`, absolute paths, `~`, Windows drive paths or symlinks | Paths resolved against the sandbox; outside → `outside:` resource, denied by policy and refused by the tool even if a policy allows it; final open uses `O_NOFOLLOW`. Tested. |
| Agent invokes arbitrary code / shell | Fixed in-code tool registry; unknown tools denied regardless of policy; no registration API. Tested. |
| Approval substitution (approve A, execute B) | Token bound to SHA-256 over agent, action, tool, resource and canonical validated arguments. Tested. |
| Token replay / theft by another agent | Single-use atomic consumption; agent binding; expiry; only hashes stored; token delivered once to the requesting agent. Tested. |
| Restoring someone else's data | Sessions belong to one agent; unknown and foreign sessions get the same denial; only placeholders in the stored mapping are replaced — callers can't supply mappings. Tested. |
| Sensitive data leaking into logs, audit or errors | Audit writer accepts whitelisted fields only; validation errors list field names and types, never inputs (FastAPI and MCP SDK defaults both echo input — both are overridden); unhandled errors log the exception type only. Database, audit and log scans in tests. |
| Revoked agent keeps working | No auth caching; status checked each call; pending approvals expired on revoke. Tested. |
| Remote access to the local API | Binds to 127.0.0.1; non-loopback requires `--allow-remote`; Host-header allowlist blocks DNS rebinding; no CORS headers are sent. |
| Key guessing on a hosted deployment | 256-bit keys; bootstrap admin key must be 32+ characters in hosted mode; failed attempts throttled per client address (429). |
| Clickjacking / XSS in dashboard | CSP `script-src 'self'`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`; React escapes content. |
| Oversized payloads | Request body cap (Content-Length and streamed), per-field length limits, file size caps. |
| Privacy tool phoning home | Presidio's public-suffix-list download and spaCy model auto-download are both disabled; the dashboard bundles its font; no telemetry. |

## Out of scope / residual risks

- **Bypass.** An agent that also has unrestricted file-system, shell or network access can simply not
  use Privara. Privara is effective only when it is the agent's sole path to the protected resources —
  configure the agent runtime accordingly.
- **Local attacker as the same OS user.** Anyone who can read `data/` can read the vault key and decrypt
  the vault, and can edit the databases. Use full-disk encryption and OS account separation.
- **Detection misses.** Presidio + spaCy is statistical; unredacted values can slip through. Restoration
  and action enforcement do not depend on detection quality, but data minimisation does.
- **Malicious admin.** The operator is fully trusted.
- **Denial of service** by a holder of a valid agent key (only failed sign-ins are throttled).
- **Hosted deployments** move the trust boundary: raw text crosses the network to your server (and
  Vercel's edge if you use its URL), and the hosting provider can access the disk. See DEPLOY.md.
- **Supply chain.** Dependencies are pinned and locked, but not vendored or audited.
- **TOCTOU in the sandbox** against a concurrent local process manipulating directories.
