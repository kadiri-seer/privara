// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CATEGORIES, detect, ibanValid, luhn } from "../engine/detect";
import { Privara } from "../engine/gateway";
import { evaluate, globMatch, SEED_POLICIES, validatePolicy } from "../engine/policy";
import { resolvePath } from "../engine/sandbox";
import { MemoryKV } from "../engine/storage";

const SAMPLE = "Send John Carter the invoice for $2,500 at john@example.com.";
const redacted = (text: string, sensitivity: "low" | "medium" | "high" = "medium") => {
  let out = text;
  for (const d of [...detect(text, DEFAULT_CATEGORIES, sensitivity)].reverse()) out = out.slice(0, d.start) + `<${d.category}>` + out.slice(d.end);
  return out;
};

describe("detection", () => {
  it("redacts the reference sentence", () => {
    expect(redacted(SAMPLE)).toBe("Send <PERSON> the invoice for <AMOUNT> at <EMAIL>.");
  });

  it.each([
    ["Call (415) 555-0132 or +44 20 7946 0958", ["PHONE", "PHONE"]],
    ["Card 4111 1111 1111 1111 expires soon", ["CARD"]],
    ["Not a card 4111 1111 1111 1112", []],
    ["IBAN GB82 WEST 1234 5698 7654 32", ["IBAN"]],
    ["Server 10.0.0.12 and 999.1.1.1", ["IP"]],
    ["My SSN is 123-45-6789", ["NATIONAL_ID"]],
    ["Order 12345678901 shipped", []],
    ["Wallet 0x52908400098527886E0F7030069857D2E4169EE7", ["CRYPTO"]],
    ["Paid $45.50 and 3,000 euros", ["AMOUNT", "AMOUNT"]],
    ["She lives at 221 Baker Street in London", ["LOCATION", "LOCATION"]],
    ["Dr Jane Smith-Taylor spoke", ["PERSON"]],
    ["Ask Sarah about it", ["PERSON"]],
    ["Email the Privacy Lab team on Monday", []],
    ["See https://example.com/a?b=1.", ["URL"]],
  ])("%s", (text, expected) => {
    expect(detect(text).map((d) => d.category)).toEqual(expected);
  });

  it("keeps titles visible", () => {
    expect(redacted("Dr Sarah Mitchell will call")).toBe("Dr <PERSON> will call");
  });

  it("sensitivity changes how many names are caught", () => {
    const text = "Marek Lindqvist approved it";
    expect(detect(text, ["PERSON"], "low")).toHaveLength(0);
    expect(detect(text, ["PERSON"], "high")).toHaveLength(1);
  });

  it("respects category selection", () => {
    expect(detect(SAMPLE, ["EMAIL"]).map((d) => d.category)).toEqual(["EMAIL"]);
  });

  it("validators", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("GB82WEST12345698765433")).toBe(false);
  });
});

describe("vault and restore", () => {
  let p: Privara;
  beforeEach(async () => {
    p = await Privara.open(new MemoryKV());
  });

  it("uses deterministic placeholders within a session and isolates sessions", async () => {
    const s = await p.vault.createSession();
    const a = await p.sanitize(SAMPLE, s.id, DEFAULT_CATEGORIES, "medium");
    expect(a.sanitizedText).toBe("Send [PERSON_1] the invoice for [AMOUNT_1] at [EMAIL_1].");
    const b = await p.sanitize("Remind JOHN@example.com; cc mary@example.com", s.id, DEFAULT_CATEGORIES, "medium");
    expect(b.sanitizedText).toBe("Remind [EMAIL_1]; cc [EMAIL_2]");
    const other = await p.vault.createSession();
    expect((await p.sanitize("bob@example.com", other.id, DEFAULT_CATEGORIES, "medium")).sanitizedText).toBe("[EMAIL_1]");
  });

  it("stores only ciphertext", async () => {
    const kv = new MemoryKV();
    const q = await Privara.open(kv);
    const s = await q.vault.createSession();
    await q.sanitize(SAMPLE, s.id, DEFAULT_CATEGORIES, "medium");
    const stored = JSON.stringify((await kv.entries("sessions")).map(([, v]) => ({ ...(v as object), entries: (v as { entries: { placeholder: string; digest: string }[] }).entries.map((e) => [e.placeholder, e.digest]) })));
    expect(stored).not.toContain("john@example.com");
    expect(stored).not.toContain("Carter");
  });

  it("restores only after explicit approval, once", async () => {
    const s = await p.vault.createSession();
    const { sanitizedText } = await p.sanitize(SAMPLE, s.id, DEFAULT_CATEGORIES, "medium");
    const first = await p.restore("you", sanitizedText, s.id);
    expect(first.status).toBe("approval_required");
    expect(first.text).toBeUndefined();
    const token = await p.approvals.approve(first.approvalRequestId!);
    const done = await p.restore("you", sanitizedText, s.id, token);
    expect(done).toMatchObject({ status: "restored", text: SAMPLE, restored: 3 });
    expect((await p.restore("you", sanitizedText, s.id, token)).reason).toBe("token_reused");
  });

  it("binds the approval to the exact text", async () => {
    const s = await p.vault.createSession();
    const { sanitizedText } = await p.sanitize(SAMPLE, s.id, DEFAULT_CATEGORIES, "medium");
    const req = await p.restore("you", "[EMAIL_1]", s.id);
    const token = await p.approvals.approve(req.approvalRequestId!);
    expect((await p.restore("you", sanitizedText, s.id, token)).reason).toBe("token_action_mismatch");
  });

  it("only replaces placeholders that belong to the session", async () => {
    const s = await p.vault.createSession();
    await p.sanitize(SAMPLE, s.id, DEFAULT_CATEGORIES, "medium");
    await p.savePolicy({ name: "allow restore", action: "privacy.restore", resource: "*", decision: "allow", priority: 5000, agent: "*" });
    const r = await p.restore("you", "[PERSON_1] [PERSON_9] [EMAIL_1]", s.id);
    expect(r.text).toBe("John Carter [PERSON_9] john@example.com");
    expect(r.unknown).toBe(1);
  });

  it("deny policy blocks restore and unknown sessions are refused", async () => {
    const s = await p.vault.createSession();
    await p.savePolicy({ name: "never", action: "privacy.restore", resource: "*", decision: "deny", priority: 5000 });
    expect((await p.restore("you", "[EMAIL_1]", s.id)).status).toBe("denied");
    expect((await p.restore("you", "[EMAIL_1]", "rs_missing")).status).toBe("denied");
  });

  it("expired approvals are rejected", async () => {
    const s = await p.vault.createSession();
    const { sanitizedText } = await p.sanitize(SAMPLE, s.id, DEFAULT_CATEGORIES, "medium");
    const req = await p.restore("you", sanitizedText, s.id);
    const token = await p.approvals.approve(req.approvalRequestId!);
    const later = Date.now() + 6 * 60_000;
    p.approvals.setClock(() => later);
    expect((await p.restore("you", sanitizedText, s.id, token)).reason).toBe("token_expired");
  });
});

describe("policies", () => {
  it.each([
    ["file.read", "sandbox:notes/a.txt", "allow"],
    ["file.read", "outside:../x", "deny"],
    ["file.write", "sandbox:protected/x", "deny"],
    ["file.write", "sandbox:outbox/x", "approval_required"],
    ["privacy.restore", "session:rs_1", "approval_required"],
    ["custom.thing", "custom:x", "deny"],
  ])("%s on %s → %s", (action, resource, decision) => {
    expect(evaluate(SEED_POLICIES, "agent", action, resource).decision).toBe(decision);
  });

  it("agent-specific rules win ties and stricter wins otherwise", () => {
    const mine = { ...SEED_POLICIES[6], id: "x", agent: "bot", decision: "deny" as const, builtIn: false };
    expect(evaluate([...SEED_POLICIES, mine], "bot", "file.read", "sandbox:a").decision).toBe("deny");
    expect(evaluate([...SEED_POLICIES, mine], "other", "file.read", "sandbox:a").decision).toBe("allow");
  });

  it("validates input", () => {
    expect(validatePolicy({ name: "x", action: "made.up", resource: "*", decision: "allow", priority: 1 }).action).toBeTruthy();
    expect(validatePolicy({ name: "x", action: "file.read", resource: "/etc", decision: "allow", priority: 1 }).resource).toBeTruthy();
    expect(Object.keys(validatePolicy({ name: "x", action: "file.*", resource: "sandbox:*", decision: "deny", priority: 1 }))).toHaveLength(0);
  });

  it("glob matching", () => {
    expect(globMatch("sandbox:outbox/a/b.txt", "sandbox:outbox/*")).toBe(true);
    expect(globMatch("sandbox:notes.txt", "sandbox:notes?txt")).toBe(true);
    expect(globMatch("file.read", "file.*")).toBe(true);
    expect(globMatch("files.read", "file.*")).toBe(false);
  });
});

describe("tools", () => {
  let p: Privara;
  beforeEach(async () => {
    p = await Privara.open(new MemoryKV());
  });

  it.each(["../x", "notes/../../x", "/etc/passwd", "~/.ssh/id_rsa", "C:\\Windows\\win.ini", "..\\x"])("traversal %s is denied", async (path) => {
    expect(resolvePath(path).inside).toBe(false);
    expect((await p.executeTool("bot", "read_file", { path })).status).toBe("denied");
  });

  it("the tool refuses outside paths even under an allow policy", async () => {
    await p.savePolicy({ name: "bad", action: "file.read", resource: "outside:*", decision: "allow", priority: 9000 });
    const r = await p.executeTool("bot", "read_file", { path: "../x" });
    expect(r.status).toBe("failed");
  });

  it("reads with redacted output", async () => {
    const s = await p.vault.createSession();
    const r = await p.executeTool("bot", "read_file", { path: "notes/client-brief.txt" }, undefined, { sessionId: s.id });
    expect(r.status).toBe("executed");
    expect(String(r.result!.content)).not.toContain("sarah.mitchell@example.org");
  });

  it("approval flow, reuse and substitution", async () => {
    const args = { path: "outbox/a.txt", content: "hello", mode: "overwrite" };
    const pending = await p.executeTool("bot", "write_file", args);
    expect(pending.status).toBe("approval_required");
    const token = await p.approvals.approve(pending.approvalRequestId!);
    expect((await p.executeTool("bot", "write_file", { ...args, content: "evil" }, token)).reason).toBe("token_action_mismatch");
    expect((await p.executeTool("other", "write_file", args, token)).reason).toBe("token_agent_mismatch");
    expect((await p.executeTool("bot", "write_file", args, token)).status).toBe("executed");
    expect(await p.sandbox.read("outbox/a.txt")).toBe("hello");
    expect((await p.executeTool("bot", "write_file", args, token)).reason).toBe("token_reused");
  });

  it("protected writes are denied and unregistered tools refused", async () => {
    expect((await p.executeTool("bot", "write_file", { path: "protected/x", content: "x" })).status).toBe("denied");
    await p.savePolicy({ name: "allow all", action: "*", resource: "*", decision: "allow", priority: 9999 });
    expect((await p.executeTool("bot", "run_shell", { cmd: "ls" })).status).toBe("denied");
  });

  it("rejects unexpected arguments", async () => {
    expect((await p.executeTool("bot", "read_file", { path: "a", extra: 1 })).status).toBe("invalid");
  });

  it("history never stores content", async () => {
    await p.executeTool("bot", "write_file", { path: "notes/secret.txt", content: "john@example.com owes $5,000" });
    await p.executeTool("bot", "transform_text", { operation: "uppercase", text: "Sarah Mitchell" });
    const dump = JSON.stringify(await p.history());
    expect(dump).not.toContain("john@example.com");
    expect(dump).not.toContain("Sarah");
    expect(await p.history()).toHaveLength(2);
  });

  it("default decision cannot be allow", async () => {
    await expect(p.setDefaultDecision("allow")).rejects.toThrow();
    await p.setDefaultDecision("approval_required");
    expect((await p.evaluate("bot", "custom.x", "custom:y")).decision).toBe("approval_required");
  });

  it("imports policies and rejects bad files", async () => {
    expect((await p.importPolicies("not json")).errors).toHaveLength(1);
    const ok = await p.importPolicies(JSON.stringify([{ name: "x", action: "file.read", resource: "sandbox:x", decision: "deny", priority: 10, agent_id: "*" }]));
    expect(ok.imported).toBe(1);
  });
});
