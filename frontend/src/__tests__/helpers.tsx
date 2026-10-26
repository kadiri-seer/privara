import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { App } from "../App";

export type Handler = (body: unknown, url: URL, init: RequestInit) => { status?: number; body: unknown } | unknown;

export interface Call {
  method: string;
  path: string;
  search: string;
  body: unknown;
  auth: string | null;
}

export const HEALTH = {
  status: "ok",
  version: "0.1.0",
  protection: "active",
  checks: { database: true, vault: true, sandbox: true },
  detector: { mode: "presidio+spacy", model: "en_core_web_sm", fallback: false },
  default_decision: "deny",
  mcp_http: true,
};

export const OVERVIEW = {
  registered_agents: 2,
  active_agents: 1,
  redactions: 7,
  allowed: 4,
  blocked: 3,
  awaiting_approval: 0,
  events: 12,
  recent: [],
  health: HEALTH,
};

/** Routes fetch() to handlers keyed by "METHOD /path". Records every call. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const all: Record<string, Handler> = {
    "GET /api/health": () => HEALTH,
    "GET /api/admin/session": () => ({ authenticated: true }),
    "GET /api/admin/overview": () => OVERVIEW,
    "GET /api/admin/approvals": () => ({ items: [] }),
    ...routes,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, path: url.pathname, search: url.search, body, auth: headers.Authorization ?? null });
    const handler = all[`${method} ${url.pathname}`];
    if (!handler) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: `No mock for ${method} ${url.pathname}` } }), { status: 404 });
    }
    const out = handler(body, url, init) as { status?: number; body?: unknown };
    const isWrapped = out && typeof out === "object" && "body" in out && "status" in out;
    const status = isWrapped ? out.status ?? 200 : 200;
    const payload = isWrapped ? out.body : out;
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

export function renderApp(path = "/", { signedIn = true } = {}) {
  if (signedIn) sessionStorage.setItem("privara.adminKey", "pv_admin_test");
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
