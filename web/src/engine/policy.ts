// Policy storage, validation and evaluation — same rules as the Privara gateway.
//
// First match wins, ordered by: higher priority, agent-specific before "*", exact action before
// wildcard, stricter decision first. Unmatched requests get the default decision (deny).

export type Decision = "allow" | "deny" | "approval_required";

export interface Policy {
  id: string;
  name: string;
  description: string;
  agent: string; // agent name, or "*"
  action: string;
  resource: string;
  decision: Decision;
  priority: number;
  enabled: boolean;
  builtIn: boolean;
}

export interface Evaluation {
  decision: Decision;
  policy: Policy | null;
  matches: Policy[];
  explanation: string;
  defaultApplied: boolean;
}

export const KNOWN_ACTIONS: Record<string, string> = {
  "file.read": "Read a file with read_file",
  "file.write": "Write a file with write_file",
  "text.transform": "Run transform_text",
  "privacy.restore": "Restore redacted values",
  "tool.unregistered": "Call a tool that doesn't exist",
};
export const RESOURCE_SCHEMES = ["sandbox:", "outside:", "session:", "builtin:", "tool:", "custom:"];
const RESTRICTIVENESS: Record<Decision, number> = { deny: 2, approval_required: 1, allow: 0 };

const seed = (p: Omit<Policy, "description" | "agent" | "enabled" | "builtIn"> & { description: string }): Policy => ({
  agent: "*",
  enabled: true,
  builtIn: true,
  ...p,
});

export const SEED_POLICIES: Policy[] = [
  seed({ id: "seed-unregistered", name: "Unregistered tools are denied", description: "Only the tools built into Privara can run.", action: "tool.unregistered", resource: "*", decision: "deny", priority: 1000 }),
  seed({ id: "seed-outside-read", name: "Reading outside the sandbox is denied", description: "Paths that escape the sandbox are refused.", action: "file.read", resource: "outside:*", decision: "deny", priority: 900 }),
  seed({ id: "seed-outside-write", name: "Writing outside the sandbox is denied", description: "Paths that escape the sandbox are refused.", action: "file.write", resource: "outside:*", decision: "deny", priority: 900 }),
  seed({ id: "seed-protected-write", name: "Writing to protected files is denied", description: "protected/ is read-only for agents.", action: "file.write", resource: "sandbox:protected/*", decision: "deny", priority: 500 }),
  seed({ id: "seed-outbox-write", name: "Writing to the outbox needs approval", description: "Files in outbox/ are meant to leave, so a person approves each write.", action: "file.write", resource: "sandbox:outbox/*", decision: "approval_required", priority: 400 }),
  seed({ id: "seed-restore", name: "Restoring redacted values needs approval", description: "Revealing original values needs a one-time approval.", action: "privacy.restore", resource: "*", decision: "approval_required", priority: 100 }),
  seed({ id: "seed-sandbox-read", name: "Reading inside the sandbox is allowed", description: "", action: "file.read", resource: "sandbox:*", decision: "allow", priority: 100 }),
  seed({ id: "seed-sandbox-write", name: "Writing inside the sandbox is allowed", description: "", action: "file.write", resource: "sandbox:*", decision: "allow", priority: 100 }),
  seed({ id: "seed-transform", name: "Text transforms are allowed", description: "transform_text has no side effects.", action: "text.transform", resource: "builtin:*", decision: "allow", priority: 100 }),
];

/** Shell-style glob: * matches anything (including /), ? one character. Case-sensitive. */
export function globMatch(value: string, pattern: string): boolean {
  const re = "^" + pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(re, "s").test(value);
}

const isWildcard = (s: string) => /[*?]/.test(s);

function order(agent: string) {
  return (a: Policy, b: Policy) =>
    b.priority - a.priority ||
    (a.agent === agent ? 0 : 1) - (b.agent === agent ? 0 : 1) ||
    (isWildcard(a.action) ? 1 : 0) - (isWildcard(b.action) ? 1 : 0) ||
    RESTRICTIVENESS[b.decision] - RESTRICTIVENESS[a.decision];
}

export function evaluate(policies: Policy[], agent: string, action: string, resource: string, defaultDecision: Decision = "deny"): Evaluation {
  const matches = policies
    .filter((p) => p.enabled && (p.agent === "*" || p.agent === agent) && globMatch(action, p.action) && globMatch(resource, p.resource))
    .sort(order(agent));
  if (!matches.length) {
    return {
      decision: defaultDecision,
      policy: null,
      matches,
      defaultApplied: true,
      explanation: `No enabled policy matches “${action}” on this resource, so the default decision (${defaultDecision === "deny" ? "deny" : "needs approval"}) applies.`,
    };
  }
  const winner = matches[0];
  const verb = { allow: "allows", deny: "denies", approval_required: "requires approval for" }[winner.decision];
  const scope = winner.agent === "*" ? "any agent" : `agent “${winner.agent}”`;
  let explanation = `“${winner.name}” (priority ${winner.priority}, for ${scope}) ${verb} “${action}” on resources matching ${winner.resource}.`;
  if (matches.length > 1) explanation += ` ${matches.length - 1} lower-precedence ${matches.length === 2 ? "policy" : "policies"} also matched.`;
  return { decision: winner.decision, policy: winner, matches, explanation, defaultApplied: false };
}

export type PolicyErrors = Partial<Record<keyof Policy, string>>;

export function validatePolicy(p: Partial<Policy>): PolicyErrors {
  const errors: PolicyErrors = {};
  if (!p.name?.trim() || p.name.length > 120) errors.name = "Give the policy a name (up to 120 characters).";
  const action = p.action?.trim() ?? "";
  if (!/^[a-z*][a-z0-9_.*?-]{0,63}$/.test(action)) errors.action = "Use an action like file.read, or a wildcard like file.*";
  else if (!isWildcard(action) && !(action in KNOWN_ACTIONS)) errors.action = "Unknown action. Pick one from the list or use a wildcard.";
  const resource = p.resource?.trim() ?? "";
  if (!resource || resource.length > 256) errors.resource = "Resource scope is required.";
  else if (resource !== "*" && !RESOURCE_SCHEMES.some((s) => resource.startsWith(s)))
    errors.resource = `Use * or start with ${RESOURCE_SCHEMES.join(" ")}`;
  if (!p.decision || !(p.decision in RESTRICTIVENESS)) errors.decision = "Choose allow, deny or needs approval.";
  if (!Number.isInteger(p.priority) || (p.priority ?? -1) < 0 || (p.priority ?? 0) > 10000) errors.priority = "Use a whole number from 0 to 10000.";
  const agent = p.agent?.trim() ?? "*";
  if (agent !== "*" && !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(agent)) errors.agent = "Use * or an agent name (letters, digits, . _ -).";
  return errors;
}
