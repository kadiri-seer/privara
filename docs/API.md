# REST API

Interactive OpenAPI docs: <http://127.0.0.1:8787/api/docs> (schema at `/api/openapi.json`).

## Conventions

- Agent endpoints (`/api/v1/*`): `Authorization: Bearer pv_agent_…`
- Operator endpoints (`/api/admin/*`): `Authorization: Bearer pv_admin_…`
- Errors always look like this, and never echo submitted values:

```json
{ "error": { "code": "validation_failed", "message": "Request validation failed.",
             "details": [{ "field": "leak", "error": "extra_forbidden" }] } }
```

| Status | Meaning |
| --- | --- |
| 200 | Done (executed, sanitized, restored, decision returned) |
| 201 | Created |
| 202 | Approval required — nothing ran yet |
| 400 | Untrusted Host header or malformed request |
| 401 | Missing / invalid key (`unauthenticated`) |
| 403 | Denied by policy, approval token refused, agent revoked (`agent_revoked`), agent_id mismatch |
| 404 | Not found |
| 409 | Conflict (e.g. approval already decided) |
| 413 | Body larger than `PRIVARA_MAX_REQUEST_BYTES` |
| 422 | Validation failed, tool refused (sandbox violation, file exists), confirmation required |

## Agent endpoints

### `POST /api/v1/sanitize`

```json
{ "text": "Send John Okafor the invoice for ₦250,000 at john@example.com.",
  "session_id": "default",
  "sensitivity": { "level": "medium", "categories": ["PERSON", "EMAIL", "AMOUNT"] } }
```

`sensitivity` is optional: `level` is `low | medium | high`, `threshold` (0–1) overrides it, and
`categories` is any of `PERSON EMAIL PHONE AMOUNT CARD IBAN IP LOCATION URL NATIONAL_ID CRYPTO DATE`.

```json
{
  "status": "sanitized",
  "sanitized_text": "Send [PERSON_1] the invoice for [AMOUNT_1] at [EMAIL_1].",
  "redaction_session_id": "rs_1dcc87652e173ecb",
  "session_id": "default",
  "entity_categories": ["AMOUNT", "EMAIL", "PERSON"],
  "category_counts": { "PERSON": 1, "AMOUNT": 1, "EMAIL": 1 },
  "redaction_count": 3,
  "placeholders": [{ "placeholder": "[PERSON_1]", "category": "PERSON" }, "…"],
  "decision_id": "evt_…",
  "detector": { "mode": "presidio+spacy", "model": "en_core_web_sm", "fallback_reason": null },
  "threshold": 0.4
}
```

The same `session_id` from the same agent reuses the redaction session, so repeated values keep their
placeholders across calls.

### `POST /api/v1/check-permission`

```json
{ "action": "file.write", "resource": "sandbox:outbox/report.txt", "context": { "purpose": "weekly report" } }
```
```json
{ "decision": "approval_required",
  "policy": { "id": "pol_seed_outbox_write", "name": "Writing to the outbox requires approval", "…": "…" },
  "explanation": "Policy “Writing to the outbox requires approval” (priority 400, applies to all agents) requires approval …",
  "decision_id": "evt_…", "default_applied": false, "note": "This is a decision only. Nothing was executed." }
```

Only the keys of `context` are recorded in the audit log.

### `POST /api/v1/execute`

```json
{ "tool_name": "read_file", "arguments": { "path": "notes/client-brief.txt" },
  "session_id": "default", "sanitize_output": true, "approval_token": null }
```

| Tool | Arguments | Action / resource |
| --- | --- | --- |
| `read_file` | `path` | `file.read` on `sandbox:<path>` or `outside:<path>` |
| `write_file` | `path`, `content`, `mode` = `create` \| `overwrite` \| `append` | `file.write` |
| `transform_text` | `operation` = `uppercase lowercase titlecase word_count char_count sha256 slugify reverse`, `text` | `text.transform` on `builtin:transform_text` |

Responses carry `status`: `executed` (200, with `result`), `denied` (403), `approval_required` (202,
with `approval_request_id`), `approval_rejected` (403, with `reason`: `token_invalid`,
`token_reused`, `token_expired`, `token_action_mismatch`, `token_agent_mismatch`,
`token_not_approved`) or `failed` (422, with `error.code`, e.g. `sandbox_violation`, `file_exists`).
`read_file` output is sanitized unless `sanitize_output` is `false`.

### `GET /api/v1/approvals/{approval_request_id}`

Returns `status` (`pending | approved | denied | consumed | expired`). After approval, the first call
returns `approval_token` and `expires_at`; later calls return `approval_token: null`.

### `POST /api/v1/restore`

```json
{ "text": "Send [PERSON_1] the invoice for [AMOUNT_1] at [EMAIL_1].",
  "redaction_session_id": "rs_1dcc87652e173ecb", "approval_token": null }
```

By default the first call returns 202 `approval_required`; after approval, repeat with the token:

```json
{ "status": "restored", "restored_text": "Send John Okafor the invoice for ₦250,000 at john@example.com.",
  "restored_count": 3, "unknown_placeholders": 0, "decision_id": "evt_…" }
```

The token is bound to the exact text; placeholders not in the session's stored mapping are left as-is.

### Other

`GET /api/v1/tools` (registered tools and JSON schemas), `GET /api/v1/whoami`, `GET /api/health` (public).

## Operator endpoints (selection)

| Method & path | Purpose |
| --- | --- |
| `GET /api/admin/overview` | Counts from the audit log, recent events, health |
| `GET/POST /api/admin/agents`, `POST …/{id}/rotate`, `…/revoke`, `…/reactivate`, `GET …/{id}/scopes` | Agent lifecycle |
| `GET/POST /api/admin/policies`, `PATCH/DELETE …/{id}`, `POST …/explain` | Policies and simulation |
| `GET /api/admin/approvals?status=pending`, `POST …/{id}/approve`, `…/deny` | Approvals |
| `GET /api/admin/activity?agent_id&action&decision&outcome&since&until&q&limit&offset`, `GET …/{id}` | Audit log |
| `POST /api/admin/lab/sanitize`, `POST /api/admin/lab/restore` | Privacy Lab (uses the built-in `privacy-lab` identity) |
| `DELETE /api/admin/sessions/{id}`, `POST /api/admin/sessions/clear` | Delete vault mappings |
| `GET/PATCH /api/admin/settings` | Defaults, retention, TTL, storage info |
| `POST /api/admin/audit/purge`, `POST /api/admin/audit/clear` | Retention and wipe |
| `GET /api/admin/credentials`, `POST …/rotate` | Admin keys |
| `POST /api/admin/demo/run`, `POST /api/admin/demo/reset` | Demo agent |

Destructive operator endpoints require the body `{"confirm": true}`.
