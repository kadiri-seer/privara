import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HEALTH, mockApi, renderApp } from "./helpers";

describe("sign in and shell", () => {
  it("signs in with an admin key and shows real overview numbers", async () => {
    const calls = mockApi({});
    renderApp("/", { signedIn: false });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Admin key"), "pv_admin_abc");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/admin/session")?.auth).toBe("Bearer pv_admin_abc");
    expect(await screen.findByTestId("metric-Values redacted")).toHaveTextContent("7");
    expect(screen.getByTestId("metric-Actions blocked")).toHaveTextContent("3");
  });

  it("rejects a wrong key with a clear message", async () => {
    mockApi({ "GET /api/admin/session": () => ({ status: 401, body: { error: { code: "unauthenticated", message: "Missing or invalid admin credential." } } }) });
    renderApp("/", { signedIn: false });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Admin key"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Missing or invalid admin credential.");
  });

  it("shows protection status from backend health, not a fixed badge", async () => {
    mockApi({ "GET /api/health": () => ({ ...HEALTH, status: "degraded", checks: { database: true, vault: false, sandbox: true } }) });
    renderApp("/");
    const status = await screen.findByTestId("protection-status");
    await waitFor(() => expect(status).toHaveTextContent("Protection impaired"));
    expect(status).toHaveTextContent("Failing: vault");
  });

  it("navigates to every section", async () => {
    mockApi({
      "GET /api/admin/settings": () => ({ settings: { default_categories: [], detection_level: "medium", default_decision: "deny", audit_retention_days: 30, approval_ttl_seconds: 300 }, categories: [], storage: { data_dir: "/d", sandbox_dir: "/s", main_db: { path: "", exists: true, bytes: 1, mode: "0o600" }, vault_db: { path: "", exists: true, bytes: 1, mode: "0o600" }, vault_key: { path: "", exists: true, bytes: 1, mode: "0o600" }, counts: { audit_events: 0, redaction_sessions: 0, vault_mappings: 0 }, encryption: { vault_values: "v", main_db: "m", caveat: "c" }, permissions_enforced: true }, limits: {} }),
      "GET /api/admin/agents": () => ({ items: [] }),
      "GET /api/admin/policies": () => ({ items: [], actions: {}, resource_schemes: [], decisions: [], default_decision: "deny" }),
      "GET /api/admin/activity": () => ({ items: [], total: 0 }),
      "GET /api/admin/activity/meta": () => ({ agents: [], actions: [], decisions: [] }),
      "GET /api/admin/integrations": () => ({ actual: { base_url: "http://127.0.0.1:8787", rest_base: "http://127.0.0.1:8787/api/v1", openapi: "x", docs: "x", mcp_http: "http://127.0.0.1:8787/mcp", mcp_stdio_command: ["uv", "run", "privara", "mcp"] }, tools: [], health: HEALTH }),
      "GET /api/admin/credentials": () => ({ items: [] }),
    });
    renderApp("/");
    const user = userEvent.setup();
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const [link, heading] of [
      ["Privacy Lab", "Privacy Lab"],
      ["Agent Access", "Agent Access"],
      ["Policies", "Policies"],
      ["Activity", "Activity"],
      ["Integrations", "Integrations"],
      ["Settings", "Settings"],
      ["Overview", "Overview"],
    ]) {
      await user.click(within(nav).getByRole("link", { name: link }));
      expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    }
  });
});

describe("Privacy Lab", () => {
  const sanitized = {
    status: "sanitized",
    sanitized_text: "Send [PERSON_1] the invoice for [AMOUNT_1] at [EMAIL_1].",
    redaction_session_id: "rs_1",
    session_id: "lab-x",
    entity_categories: ["AMOUNT", "EMAIL", "PERSON"],
    category_counts: { PERSON: 1, AMOUNT: 1, EMAIL: 1 },
    redaction_count: 3,
    placeholders: [
      { placeholder: "[PERSON_1]", category: "PERSON" },
      { placeholder: "[AMOUNT_1]", category: "AMOUNT" },
      { placeholder: "[EMAIL_1]", category: "EMAIL" },
    ],
    entities: [
      { category: "PERSON", start: 5, end: 16, score: 0.85, placeholder: "[PERSON_1]", sanitized_start: 5, sanitized_end: 15 },
    ],
    detector: { mode: "presidio+spacy", model: "en_core_web_sm", fallback_reason: null },
    threshold: 0.4,
    decision_id: "evt_1",
  };

  it("sanitizes locally and restores only through the approval flow", async () => {
    const calls = mockApi({
      "GET /api/admin/settings": () => ({ settings: { default_categories: ["PERSON", "EMAIL"], detection_level: "medium" }, categories: [{ id: "PERSON", label: "Person names" }, { id: "EMAIL", label: "Email addresses" }] }),
      "POST /api/admin/lab/sanitize": () => sanitized,
      "POST /api/admin/lab/restore": (body) =>
        (body as { approval_request_id?: string }).approval_request_id
          ? { status: "restored", restored_text: "Send John Okafor the invoice for ₦250,000 at john@example.com.", restored_count: 3, explanation: "ok" }
          : { status: "approval_required", approval_request_id: "apr_1", explanation: "Restoring needs approval." },
      "POST /api/admin/approvals/apr_1/approve": () => ({ id: "apr_1", status: "approved" }),
    });
    renderApp("/privacy-lab");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Text to sanitize"), "Send John Okafor the invoice for ₦250,000 at john@example.com.");
    await user.click(screen.getByRole("button", { name: "Sanitize" }));

    const view = await screen.findByTestId("sanitized-view");
    expect(within(view).getByText("PERSON_1")).toHaveClass("veil");
    expect(view).not.toHaveTextContent("John");
    const sent = calls.find((c) => c.path === "/api/admin/lab/sanitize")!;
    expect(sent.body).toMatchObject({ sensitivity: { level: "medium", categories: ["PERSON", "EMAIL"] } });
    expect(screen.getByTestId("original-view").querySelector("mark")).toHaveTextContent("John Okafor");

    await user.click(screen.getByRole("button", { name: "Request restore" }));
    expect(await screen.findByText("Approval needed")).toBeInTheDocument();
    expect(view).not.toHaveTextContent("John");

    await user.click(screen.getByRole("button", { name: "Approve and restore" }));
    await waitFor(() => expect(screen.getByTestId("sanitized-view")).toHaveTextContent("John Okafor"));
    const restoreCalls = calls.filter((c) => c.path === "/api/admin/lab/restore");
    expect(restoreCalls[1].body).toMatchObject({ approval_request_id: "apr_1" });
    expect(calls.some((c) => c.path === "/api/admin/approvals/apr_1/approve")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Hide originals" }));
    expect(screen.getByTestId("sanitized-view")).not.toHaveTextContent("John");
  });

  it("asks for confirmation before clearing a session", async () => {
    const calls = mockApi({
      "GET /api/admin/settings": () => ({ settings: { default_categories: [], detection_level: "medium" }, categories: [] }),
      "POST /api/admin/lab/sanitize": () => sanitized,
      "DELETE /api/admin/sessions/rs_1": () => ({ cleared_mappings: 3 }),
    });
    renderApp("/privacy-lab");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Text to sanitize"), "x");
    await user.click(screen.getByRole("button", { name: "Sanitize" }));
    await user.click(await screen.findByRole("button", { name: "Clear session data" }));
    const dialog = screen.getByRole("dialog");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Clear session" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/admin/sessions/rs_1")).toBe(true));
  });
});

describe("Policies", () => {
  it("creates a policy and surfaces backend validation errors per field", async () => {
    let attempt = 0;
    const calls = mockApi({
      "GET /api/admin/policies": () => ({ items: [], actions: { "file.read": "Read a file" }, resource_schemes: ["sandbox:"], decisions: [], default_decision: "deny" }),
      "GET /api/admin/agents": () => ({ items: [] }),
      "POST /api/admin/policies": () =>
        ++attempt === 1
          ? { status: 422, body: { error: { code: "validation_failed", message: "Policy is invalid.", details: [{ field: "resource", message: "Resource must be '*' or start with sandbox:" }] } } }
          : { status: 201, body: { id: "pol_new" } },
    });
    renderApp("/policies");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New policy" }));
    await user.type(screen.getByLabelText("Name"), "Block notes");
    const resource = screen.getByLabelText("Resource scope");
    await user.clear(resource);
    await user.type(resource, "/etc");
    await user.click(screen.getByRole("radio", { name: "Deny" }));
    await user.click(screen.getByRole("button", { name: "Create policy" }));
    expect(await screen.findByText("Resource must be '*' or start with sandbox:")).toBeInTheDocument();

    await user.clear(resource);
    await user.type(resource, "sandbox:notes/*");
    await user.click(screen.getByRole("button", { name: "Create policy" }));
    expect(await screen.findByText("Policy created. It applies to the next request.")).toBeInTheDocument();
    const posted = calls.filter((c) => c.method === "POST" && c.path === "/api/admin/policies").at(-1)!;
    expect(posted.body).toMatchObject({ name: "Block notes", resource: "sandbox:notes/*", decision: "deny", agent_id: "*" });
  });
});

describe("Activity", () => {
  const event = {
    id: "evt_9", ts: new Date().toISOString(), agent_id: "agt_1", agent_name: "research-bot", channel: "mcp",
    action: "file.read", tool_name: "read_file", resource: "outside:../vault.key", decision: "deny", policy_id: "p",
    policy_name: "Reading outside the sandbox is denied", explanation: "Policy denies it.", outcome: "blocked",
    outcome_description: "", executed: false, approval_status: null, approval_request_id: null, redaction_count: 0,
    entity_categories: [], redaction_session_id: null, details: {}, is_demo: false,
  };

  it("filters by decision and explains a blocked event without running it", async () => {
    const calls = mockApi({
      "GET /api/admin/activity": () => ({ items: [event], total: 1 }),
      "GET /api/admin/activity/meta": () => ({ agents: [{ id: "agt_1", name: "research-bot" }], actions: ["file.read"], decisions: [] }),
      "GET /api/admin/activity/evt_9": () => ({ event, approval: null }),
    });
    renderApp("/activity");
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /Read file/ });
    await user.selectOptions(screen.getByLabelText("Decision"), "deny");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/admin/activity" && c.search.includes("decision=deny"))).toBe(true));
    await user.click(screen.getByRole("button", { name: /Read file/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Did not run");
    expect(dialog).toHaveTextContent("Reading outside the sandbox is denied");
  });
});

describe("Agent Access", () => {
  it("shows a new key once and confirms before revoking", async () => {
    let agents: unknown[] = [];
    const agent = { id: "agt_new", name: "helper", description: "", status: "active", is_system: false, has_credential: true, created_at: new Date().toISOString(), key_rotated_at: null, last_seen_at: null, revoked_at: null };
    const calls = mockApi({
      "GET /api/admin/agents": () => ({ items: agents }),
      "POST /api/admin/agents": () => {
        agents = [agent];
        return { status: 201, body: { agent, api_key: "pv_agent_aaaaaaaaaaaa_secret" } };
      },
      "GET /api/admin/agents/agt_new/scopes": () => ({ agent, policies: [], default_decision: "deny", last_activity: null }),
      "POST /api/admin/agents/agt_new/revoke": () => ({ agent: { ...agent, status: "revoked" }, expired_approvals: 0 }),
    });
    renderApp("/agents");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Register agent" }));
    await user.type(screen.getByLabelText("Name"), "helper");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByTestId("secret-value")).toHaveTextContent("pv_agent_aaaaaaaaaaaa_secret");
    await user.click(screen.getByRole("button", { name: "I’ve stored it" }));
    expect(screen.queryByTestId("secret-value")).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Revoke access" }));
    const dialog = screen.getByRole("dialog");
    expect(calls.some((c) => c.path.endsWith("/revoke"))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Revoke access" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/admin/agents/agt_new/revoke")).toBe(true));
  });
});

describe("hosted deployment", () => {
  it("tells the operator where the hosted admin key lives", async () => {
    mockApi({ "GET /api/health": () => ({ ...HEALTH, deployment: "hosted" }) });
    renderApp("/", { signedIn: false });
    expect(await screen.findByText("PRIVARA_ADMIN_API_KEY")).toBeInTheDocument();
    expect(screen.queryByText("privara init")).not.toBeInTheDocument();
  });
});
