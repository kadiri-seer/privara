// Typed client for the local Privara backend. All requests stay on this origin.

const KEY_STORAGE = "privara.adminKey";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: { field?: string; message?: string; error?: string }[];

  constructor(status: number, code: string, message: string, details?: ApiError["details"]) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function getAdminKey(): string | null {
  try {
    return sessionStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setAdminKey(key: string | null): void {
  try {
    if (key) sessionStorage.setItem(KEY_STORAGE, key);
    else sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage unavailable: the key lives only in memory for this page */
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

export async function request<T>(method: string, path: string, body?: unknown, key?: string): Promise<T> {
  const token = key ?? getAdminKey();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "network_error", "The Privara backend is not reachable. Is the server running?");
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const err = data?.error;
    if (response.status === 401 && path.startsWith("/api/admin") && !key) onUnauthorized();
    throw new ApiError(response.status, err?.code ?? "http_error", err?.message ?? "Request failed.", err?.details);
  }
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>("GET", path),
  post: <T,>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  patch: <T,>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T,>(path: string) => request<T>("DELETE", path),
};

export type Decision = "allow" | "deny" | "approval_required";

export interface Health {
  status: "ok" | "degraded";
  version: string;
  protection: "active" | "impaired";
  checks: Record<string, boolean>;
  detector: { mode: string; model: string | null; fallback: boolean };
  default_decision: string;
  mcp_http: boolean;
  deployment: "local" | "hosted";
}

export interface AuditEvent {
  id: string;
  ts: string;
  agent_id: string | null;
  agent_name: string | null;
  channel: string;
  action: string;
  tool_name: string | null;
  resource: string | null;
  decision: Decision;
  policy_id: string | null;
  policy_name: string | null;
  explanation: string;
  outcome: string;
  outcome_description: string;
  executed: boolean;
  approval_status: string | null;
  approval_request_id: string | null;
  redaction_count: number;
  entity_categories: string[];
  redaction_session_id: string | null;
  details: Record<string, unknown>;
  is_demo: boolean;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  status: "active" | "revoked";
  is_system: boolean;
  has_credential: boolean;
  created_at: string;
  key_rotated_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface Policy {
  id: string;
  name: string;
  description: string;
  agent_id: string;
  action: string;
  resource: string;
  decision: Decision;
  priority: number;
  enabled: boolean;
  origin: "seed" | "user";
  created_at: string;
  updated_at: string;
  scope?: "agent" | "global";
}

export interface Approval {
  id: string;
  agent_id: string;
  action: string;
  resource: string;
  tool_name: string | null;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  summary: Record<string, unknown>;
  created_at: string;
  expires_at: string | null;
  decided_by: string | null;
  is_demo: boolean;
}

export interface Overview {
  registered_agents: number;
  active_agents: number;
  redactions: number;
  allowed: number;
  blocked: number;
  awaiting_approval: number;
  events: number;
  recent: AuditEvent[];
  health: Health;
}

export interface SanitizeResult {
  status: string;
  sanitized_text: string;
  redaction_session_id: string;
  session_id: string;
  entity_categories: string[];
  category_counts: Record<string, number>;
  redaction_count: number;
  placeholders: { placeholder: string; category: string }[];
  entities?: {
    category: string;
    start: number;
    end: number;
    score: number;
    placeholder: string;
    sanitized_start: number;
    sanitized_end: number;
  }[];
  detector: { mode: string; model: string | null; fallback_reason: string | null };
  threshold: number;
  decision_id: string;
  explanation?: string;
}

export interface RestoreResult {
  status: string;
  restored_text?: string;
  restored_count?: number;
  unknown_placeholders?: number;
  approval_request_id?: string;
  explanation?: string;
  message?: string;
  reason?: string;
}

export interface DemoStep {
  step: number;
  title: string;
  mcp_tool: string;
  expected: string;
  status: string;
  passed: boolean;
  explanation?: string;
  message?: string;
  sanitized_text?: string;
  output_preview?: string;
  note?: string;
  decision_id?: string;
}

export interface DemoResult {
  transport: string;
  steps: DemoStep[];
  all_passed: boolean;
  mcp_tools_listed: string[];
}
