// The in-browser gateway: policy evaluation, approvals, tool execution and safe restore.

import { ApprovalRejected, Approvals, type RejectionReason } from "./approvals";
import { DEFAULT_CATEGORIES, type Category, type Sensitivity } from "./detect";
import { SEED_POLICIES, evaluate, validatePolicy, type Decision, type Evaluation, type Policy, type PolicyErrors } from "./policy";
import { MAX_FILE_CHARS, Sandbox, resolvePath } from "./sandbox";
import { canonical, openStorage, randomHex, sha256Hex, type KV } from "./storage";
import { Vault, type SanitizeResult } from "./vault";

export type Outcome = "executed" | "failed" | "blocked" | "pending_approval" | "approval_rejected" | "decision_only" | "restored" | "rejected";

export interface HistoryEntry {
  id: string;
  ts: string;
  agent: string;
  action: string;
  tool: string | null;
  resource: string;
  decision: Decision;
  outcome: Outcome;
  explanation: string;
}

export interface ToolOutcome {
  status: "executed" | "denied" | "approval_required" | "approval_rejected" | "failed" | "invalid";
  decision?: Decision;
  evaluation?: Evaluation;
  resource?: string;
  explanation: string;
  result?: Record<string, unknown>;
  error?: string;
  approvalRequestId?: string;
  reason?: RejectionReason;
}

export interface RestoreOutcome {
  status: "restored" | "denied" | "approval_required" | "approval_rejected";
  explanation: string;
  text?: string;
  restored?: number;
  unknown?: number;
  approvalRequestId?: string;
  reason?: RejectionReason;
}

export const TOOLS = {
  read_file: { action: "file.read", description: "Read a text file from your browser sandbox. Output is redacted by default." },
  write_file: { action: "file.write", description: "Create, overwrite or append to a file in your browser sandbox." },
  transform_text: { action: "text.transform", description: "Change case, count words or characters, hash, slugify or reverse text." },
} as const;
export type ToolName = keyof typeof TOOLS;
export const TRANSFORMS = ["uppercase", "lowercase", "titlecase", "word_count", "char_count", "sha256", "slugify", "reverse"] as const;

const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

function validateArgs(tool: ToolName, args: Record<string, unknown>): string | null {
  const allowed: Record<ToolName, string[]> = {
    read_file: ["path"],
    write_file: ["path", "content", "mode"],
    transform_text: ["operation", "text"],
  };
  const extra = Object.keys(args).filter((k) => !allowed[tool].includes(k));
  if (extra.length) return `Unexpected argument: ${extra.join(", ")}.`;
  if (tool !== "transform_text") {
    if (typeof args.path !== "string" || !args.path.length || args.path.length > 512) return "path must be 1–512 characters.";
  }
  if (tool === "write_file") {
    if (typeof args.content !== "string" || args.content.length > MAX_FILE_CHARS) return `content must be text up to ${MAX_FILE_CHARS} characters.`;
    if (args.mode !== undefined && !["create", "overwrite", "append"].includes(String(args.mode))) return "mode must be create, overwrite or append.";
  }
  if (tool === "transform_text") {
    if (!TRANSFORMS.includes(args.operation as (typeof TRANSFORMS)[number])) return `operation must be one of ${TRANSFORMS.join(", ")}.`;
    if (typeof args.text !== "string" || args.text.length > 50_000) return "text must be up to 50,000 characters.";
  }
  return null;
}

async function transform(operation: string, text: string): Promise<string | number> {
  switch (operation) {
    case "uppercase": return text.toUpperCase();
    case "lowercase": return text.toLowerCase();
    case "titlecase": return text.replace(/\b\w/g, (c) => c.toUpperCase());
    case "word_count": return text.split(/\s+/).filter(Boolean).length;
    case "char_count": return text.length;
    case "sha256": return sha256Hex(text);
    case "slugify": return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    default: return [...text].reverse().join("");
  }
}

export class Privara {
  readonly vault: Vault;
  readonly sandbox: Sandbox;
  readonly approvals = new Approvals();

  private constructor(readonly kv: KV) {
    this.vault = new Vault(kv);
    this.sandbox = new Sandbox(kv);
  }

  static async open(kv?: KV): Promise<Privara> {
    const p = new Privara(kv ?? (await openStorage()));
    await p.sandbox.seed();
    if (!(await p.kv.get<Policy[]>("policies", "list"))) await p.kv.put("policies", "list", SEED_POLICIES);
    return p;
  }

  get persistent() {
    return this.kv.persistent;
  }

  // ---- settings & policies -------------------------------------------------------------------
  async defaultDecision(): Promise<Decision> {
    return (await this.kv.get<Decision>("settings", "defaultDecision")) ?? "deny";
  }
  async setDefaultDecision(d: Decision) {
    if (d === "allow") throw new Error("Unmatched requests can be denied or need approval, never allowed by default.");
    await this.kv.put("settings", "defaultDecision", d);
  }
  async policies(): Promise<Policy[]> {
    return (await this.kv.get<Policy[]>("policies", "list")) ?? [];
  }
  async savePolicy(input: Partial<Policy>): Promise<{ policy?: Policy; errors?: PolicyErrors }> {
    const errors = validatePolicy(input);
    if (Object.keys(errors).length) return { errors };
    const list = await this.policies();
    const existing = input.id ? list.find((p) => p.id === input.id) : undefined;
    const policy: Policy = {
      id: existing?.id ?? "pol_" + randomHex(5),
      builtIn: existing?.builtIn ?? false,
      name: input.name!.trim(),
      description: (input.description ?? "").trim().slice(0, 300),
      agent: (input.agent ?? "*").trim() || "*",
      action: input.action!.trim(),
      resource: input.resource!.trim(),
      decision: input.decision!,
      priority: input.priority!,
      enabled: input.enabled ?? true,
    };
    await this.kv.put("policies", "list", existing ? list.map((p) => (p.id === policy.id ? policy : p)) : [...list, policy]);
    return { policy };
  }
  async deletePolicy(id: string) {
    const list = await this.policies();
    const target = list.find((p) => p.id === id);
    if (target?.builtIn) throw new Error("Built-in policies can't be deleted. Turn them off instead.");
    await this.kv.put("policies", "list", list.filter((p) => p.id !== id));
  }
  async resetPolicies() {
    await this.kv.put("policies", "list", SEED_POLICIES);
    await this.kv.put("settings", "defaultDecision", "deny");
  }
  async importPolicies(json: string): Promise<{ imported: number; errors: string[] }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { imported: 0, errors: ["The file isn't valid JSON."] };
    }
    const items = Array.isArray(parsed) ? parsed : (parsed as { policies?: unknown[] })?.policies;
    if (!Array.isArray(items)) return { imported: 0, errors: ["Expected a list of policies."] };
    const errors: string[] = [];
    const clean: Policy[] = [];
    items.forEach((raw, i) => {
      const p = raw as Partial<Policy> & { agent_id?: string };
      const candidate = { ...p, agent: p.agent ?? p.agent_id ?? "*", priority: Number(p.priority ?? 100), enabled: p.enabled !== false };
      const problems = validatePolicy(candidate);
      if (Object.keys(problems).length) errors.push(`Policy ${i + 1}: ${Object.values(problems)[0]}`);
      else clean.push({ ...(candidate as Policy), id: "pol_" + randomHex(5), builtIn: false, description: String(p.description ?? "") });
    });
    if (!errors.length) await this.kv.put("policies", "list", [...(await this.policies()), ...clean]);
    return { imported: errors.length ? 0 : clean.length, errors };
  }
  async evaluate(agent: string, action: string, resource: string) {
    return evaluate(await this.policies(), agent, action, resource, await this.defaultDecision());
  }

  // ---- history (identifiers and decisions only — never content) ----------------------------
  private async record(e: Omit<HistoryEntry, "id" | "ts">) {
    const entry: HistoryEntry = { ...e, id: "evt_" + randomHex(6), ts: new Date().toISOString() };
    await this.kv.put("history", `${entry.ts}_${entry.id}`, entry);
    const all = await this.kv.entries<HistoryEntry>("history");
    if (all.length > 300) {
      for (const [key] of all.sort(([a], [b]) => a.localeCompare(b)).slice(0, all.length - 300)) await this.kv.delete("history", key);
    }
    return entry;
  }
  async history(): Promise<HistoryEntry[]> {
    return (await this.kv.entries<HistoryEntry>("history")).map(([, v]) => v).sort((a, b) => b.ts.localeCompare(a.ts));
  }
  async clearHistory() {
    await this.kv.clear("history");
  }

  // ---- privacy -------------------------------------------------------------------------------
  sanitize(text: string, sessionId: string, categories: Category[], sensitivity: Sensitivity): Promise<SanitizeResult> {
    return this.vault.sanitize(text, sessionId, categories, sensitivity);
  }

  async restore(agent: string, text: string, sessionId: string, token?: string): Promise<RestoreOutcome> {
    const resource = `session:${sessionId}`;
    const session = await this.vault.get(sessionId);
    if (!session) return { status: "denied", explanation: "That session doesn't exist in this browser." };
    const ev = await this.evaluate(agent, "privacy.restore", resource);
    const base = { agent, action: "privacy.restore", tool: null, resource, decision: ev.decision };
    if (ev.decision === "deny") {
      await this.record({ ...base, outcome: "blocked", explanation: ev.explanation });
      return { status: "denied", explanation: ev.explanation };
    }
    let approvalNote = "";
    if (ev.decision === "approval_required") {
      const binding = await sha256Hex(canonical({ agent, action: "privacy.restore", resource, text: await sha256Hex(text) }));
      if (!token) {
        const preview = await this.vault.preview(text, sessionId);
        const req = this.approvals.create({
          agent, action: "privacy.restore", resource, tool: null, binding,
          summary: `Reveal ${preview.known.length} value${preview.known.length === 1 ? "" : "s"}${preview.known.length ? ` (${[...new Set(preview.known.map((k) => k.category))].join(", ")})` : ""}`,
        });
        await this.record({ ...base, outcome: "pending_approval", explanation: ev.explanation });
        return { status: "approval_required", explanation: ev.explanation, approvalRequestId: req.id };
      }
      try {
        const used = await this.approvals.consume(agent, token, binding);
        approvalNote = `Approved by you (${used.id}); the one-time token is now used. `;
      } catch (e) {
        const reason = (e as ApprovalRejected).reason;
        await this.record({ ...base, outcome: "approval_rejected", explanation: (e as Error).message });
        return { status: "approval_rejected", explanation: (e as Error).message, reason };
      }
    }
    const result = await this.vault.restoreUnchecked(text, sessionId);
    await this.record({ ...base, outcome: "restored", explanation: approvalNote + ev.explanation });
    return { status: "restored", explanation: approvalNote + ev.explanation, text: result.text, restored: result.restored, unknown: result.unknown };
  }

  // ---- actions -------------------------------------------------------------------------------
  /** The action and resource a tool call maps to, without running it. */
  describeCall(tool: string, args: Record<string, unknown>): { action: string; resource: string } {
    if (!(tool in TOOLS)) return { action: "tool.unregistered", resource: `tool:${tool.slice(0, 64)}` };
    const name = tool as ToolName;
    if (name === "transform_text") return { action: TOOLS[name].action, resource: "builtin:transform_text" };
    const r = resolvePath(String(args.path ?? ""));
    return { action: TOOLS[name].action, resource: r.inside ? `sandbox:${r.path}` : `outside:${r.path}` };
  }

  async checkPermission(agent: string, action: string, resource: string): Promise<Evaluation> {
    const ev = await this.evaluate(agent, action, resource);
    await this.record({ agent, action, tool: null, resource, decision: ev.decision, outcome: "decision_only", explanation: ev.explanation });
    return ev;
  }

  async executeTool(
    agent: string,
    tool: string,
    args: Record<string, unknown>,
    token?: string,
    options: { sanitizeOutput?: boolean; sessionId?: string } = {},
  ): Promise<ToolOutcome> {
    if (!AGENT_RE.test(agent)) return { status: "invalid", explanation: "Agent name must be letters, digits, spaces, dots, dashes or underscores." };
    if (!(tool in TOOLS)) {
      const resource = `tool:${tool.slice(0, 64)}`;
      const ev = await this.evaluate(agent, "tool.unregistered", resource);
      const explanation = `“${tool.slice(0, 64)}” isn't one of Privara's tools, so it can't run. Tools are fixed; agents can't add new ones.`;
      await this.record({ agent, action: "tool.unregistered", tool: tool.slice(0, 64), resource, decision: "deny", outcome: "rejected", explanation });
      return { status: "denied", decision: "deny", evaluation: ev, resource, explanation };
    }
    const name = tool as ToolName;
    const problem = validateArgs(name, args);
    if (problem) return { status: "invalid", explanation: problem };

    const action = TOOLS[name].action;
    let resource = "builtin:transform_text";
    let resolved = { inside: true, path: "" };
    if (name !== "transform_text") {
      resolved = resolvePath(String(args.path));
      resource = resolved.inside ? `sandbox:${resolved.path}` : `outside:${resolved.path}`;
    }
    const ev = await this.evaluate(agent, action, resource);
    const base = { agent, action, tool: name, resource, decision: ev.decision };
    const common = { decision: ev.decision, evaluation: ev, resource };

    if (ev.decision === "deny") {
      await this.record({ ...base, outcome: "blocked", explanation: ev.explanation });
      return { status: "denied", ...common, explanation: ev.explanation };
    }

    let explanation = ev.explanation;
    if (ev.decision === "approval_required") {
      const normalised = { ...args, ...(name === "write_file" ? { mode: args.mode ?? "create" } : {}) };
      const binding = await sha256Hex(canonical({ agent, action, tool: name, resource, args: normalised }));
      if (!token) {
        const summary =
          name === "write_file"
            ? `${String(normalised.mode)} ${resolved.path} (${String(args.content).length} characters)`
            : `${name} on ${resource}`;
        const req = this.approvals.create({ agent, action, resource, tool: name, binding, summary });
        await this.record({ ...base, outcome: "pending_approval", explanation });
        return { status: "approval_required", ...common, explanation, approvalRequestId: req.id };
      }
      try {
        const used = await this.approvals.consume(agent, token, binding);
        explanation = `Approved (${used.id}); the one-time token is now used. ${explanation}`;
      } catch (e) {
        await this.record({ ...base, outcome: "approval_rejected", explanation: (e as Error).message });
        return { status: "approval_rejected", ...common, explanation: (e as Error).message, reason: (e as ApprovalRejected).reason };
      }
    }

    // Allowed: the tool still enforces the sandbox on its own, whatever the policy says.
    try {
      let result: Record<string, unknown>;
      if (name === "transform_text") {
        result = { operation: args.operation, output: await transform(String(args.operation), String(args.text)) };
      } else if (!resolved.inside || resolved.path === ".") {
        throw new Error("That path is outside the sandbox. The tool refuses it whatever the policy says.");
      } else if (name === "read_file") {
        const content = await this.sandbox.read(resolved.path);
        if (content === undefined) throw new Error("That file doesn't exist in your sandbox.");
        result = { path: resolved.path, content };
        if (options.sanitizeOutput !== false && options.sessionId) {
          const s = await this.vault.sanitize(content, options.sessionId, DEFAULT_CATEGORIES, "medium");
          result = { ...result, content: s.sanitizedText, redacted: s.redactions.length };
        }
      } else {
        const mode = String(args.mode ?? "create");
        const existing = await this.sandbox.read(resolved.path);
        if (mode === "create" && existing !== undefined) throw new Error("That file already exists. Use overwrite or append.");
        const content = mode === "append" ? (existing ?? "") + String(args.content) : String(args.content);
        if (content.length > MAX_FILE_CHARS) throw new Error("The file would be too large.");
        await this.sandbox.write(resolved.path, content);
        result = { path: resolved.path, mode, characters_written: String(args.content).length };
      }
      await this.record({ ...base, outcome: "executed", explanation });
      return { status: "executed", ...common, explanation, result };
    } catch (e) {
      await this.record({ ...base, outcome: "failed", explanation: `${explanation} ${(e as Error).message}` });
      return { status: "failed", ...common, explanation, error: (e as Error).message };
    }
  }
}
