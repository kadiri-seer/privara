import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { TOOLS, TRANSFORMS, type HistoryEntry, type ToolOutcome } from "../engine/gateway";
import { KNOWN_ACTIONS, RESOURCE_SCHEMES, type Decision, type Evaluation, type Policy, type PolicyErrors } from "../engine/policy";
import { useEngine } from "../engine-context";
import {
  Button,
  ConfirmDialog,
  DecisionBadge,
  Dialog,
  EmptyState,
  Field,
  PageHeader,
  Panel,
  PanelTitle,
  Segmented,
  Switch,
  Tag,
  VeiledText,
  actionLabel,
  cx,
  inputClass,
  relativeTime,
  useToast,
} from "../components/ui";

type ToolChoice = keyof typeof TOOLS | "other";

const OUTCOME_LABEL: Record<string, string> = {
  executed: "Ran",
  failed: "Allowed, but the tool refused",
  blocked: "Did not run",
  rejected: "Did not run",
  pending_approval: "Waiting for approval",
  approval_rejected: "Did not run, approval refused",
  decision_only: "Checked only",
  restored: "Values restored",
};

export function Actions() {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  return (
    <>
      <PageHeader
        title="Action protection"
        description="Check what an AI agent is allowed to do before it does it. Tool calls are evaluated against your policies, then allowed, denied or held until you approve. Everything runs against a small file sandbox in your browser."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <ToolCallPanel onChange={bump} />
        <SandboxPanel version={version} onChange={bump} />
      </div>
      <PoliciesPanel version={version} onChange={bump} />
      <HistoryPanel version={version} onChange={bump} />
    </>
  );
}

// ---- tool calls --------------------------------------------------------------------------------
function ToolCallPanel({ onChange }: { onChange: () => void }) {
  const engine = useEngine();
  const toast = useToast();
  const [agent, setAgent] = useState("my-agent");
  const [tool, setTool] = useState<ToolChoice>("read_file");
  const [otherName, setOtherName] = useState("run_shell");
  const [path, setPath] = useState("notes/client-brief.txt");
  const [content, setContent] = useState("Invoice draft for [PERSON_1]");
  const [mode, setMode] = useState<"create" | "overwrite" | "append">("overwrite");
  const [operation, setOperation] = useState<(typeof TRANSFORMS)[number]>("word_count");
  const [text, setText] = useState("Your agents. Your boundaries.");
  const [redactOutput, setRedactOutput] = useState(true);
  const [outcome, setOutcome] = useState<ToolOutcome | null>(null);
  const [check, setCheck] = useState<Evaluation | null>(null);
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<string | null>(null);

  const toolName = tool === "other" ? otherName.trim() || "unknown_tool" : tool;
  const args = (): Record<string, unknown> =>
    tool === "read_file" ? { path } : tool === "write_file" ? { path, content, mode } : tool === "transform_text" ? { operation, text } : {};

  async function outputSession() {
    if (!sessionRef.current) sessionRef.current = (await engine.vault.createSession("Tool output")).id;
    return sessionRef.current;
  }

  async function run(e?: FormEvent, token?: string) {
    e?.preventDefault();
    setBusy(true);
    setCheck(null);
    try {
      const r = await engine.executeTool(agent.trim(), toolName, args(), token, {
        sanitizeOutput: redactOutput,
        sessionId: tool === "read_file" && redactOutput ? await outputSession() : undefined,
      });
      setOutcome(r);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function checkOnly() {
    const { action, resource } = engine.describeCall(toolName, args());
    setOutcome(null);
    setCheck(await engine.checkPermission(agent.trim() || "my-agent", action, resource));
    onChange();
  }

  async function decide(approve: boolean) {
    if (!outcome?.approvalRequestId) return;
    if (!approve) {
      engine.approvals.deny(outcome.approvalRequestId);
      setOutcome({ ...outcome, status: "denied", explanation: "You denied the request. The tool did not run." });
      onChange();
      return;
    }
    const token = await engine.approvals.approve(outcome.approvalRequestId);
    toast("Approved. Running the call once with a single-use token.");
    await run(undefined, token);
  }

  return (
    <Panel>
      <PanelTitle hint="Pick what the agent wants to do. Privara decides before anything runs.">Check a tool call</PanelTitle>
      <form onSubmit={run} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Agent name" hint="Policies can target a specific agent.">
            {(id, d) => <input id={id} aria-describedby={d} className={inputClass} value={agent} onChange={(e) => setAgent(e.target.value)} maxLength={64} required />}
          </Field>
          <Field label="Tool">
            {(id) => (
              <select id={id} className={inputClass} value={tool} onChange={(e) => { setTool(e.target.value as ToolChoice); setOutcome(null); setCheck(null); }}>
                <option value="read_file">read_file — read a file</option>
                <option value="write_file">write_file — write a file</option>
                <option value="transform_text">transform_text — change text</option>
                <option value="other">Another tool name…</option>
              </select>
            )}
          </Field>
        </div>

        {tool === "other" ? (
          <Field label="Tool name" hint="Agents sometimes ask for tools that don’t exist. Privara refuses them.">
            {(id, d) => <input id={id} aria-describedby={d} className={inputClass + " font-mono"} value={otherName} onChange={(e) => setOtherName(e.target.value)} />}
          </Field>
        ) : null}

        {tool === "read_file" || tool === "write_file" ? (
          <Field label="Path" hint="Relative to your sandbox. Try ../secret or outbox/report.txt.">
            {(id, d) => <input id={id} aria-describedby={d} className={inputClass + " font-mono"} value={path} onChange={(e) => setPath(e.target.value)} maxLength={512} required />}
          </Field>
        ) : null}

        {tool === "write_file" ? (
          <>
            <Field label="Content">
              {(id) => <textarea id={id} rows={3} className={inputClass + " h-auto py-2.5"} value={content} onChange={(e) => setContent(e.target.value)} />}
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink-soft">Mode</span>
              <Segmented label="Write mode" value={mode} onChange={setMode} options={[{ value: "create", label: "Create" }, { value: "overwrite", label: "Overwrite" }, { value: "append", label: "Append" }]} />
            </div>
          </>
        ) : null}

        {tool === "transform_text" ? (
          <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
            <Field label="Operation">
              {(id) => (
                <select id={id} className={inputClass} value={operation} onChange={(e) => setOperation(e.target.value as (typeof TRANSFORMS)[number])}>
                  {TRANSFORMS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
            </Field>
            <Field label="Text">
              {(id) => <input id={id} className={inputClass} value={text} onChange={(e) => setText(e.target.value)} />}
            </Field>
          </div>
        ) : null}

        {tool === "read_file" ? (
          <label className="flex items-center gap-2 text-[13px]">
            <Switch checked={redactOutput} onChange={setRedactOutput} label="Redact the file contents" />
            Redact personal details in what the agent gets back
          </label>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" busy={busy}>Run through Privara</Button>
          <Button onClick={checkOnly}>Check without running</Button>
        </div>
      </form>

      {check ? (
        <div className="mt-5 rounded-2xl bg-sunken p-4" aria-live="polite">
          <div className="flex items-center gap-2"><DecisionBadge decision={check.decision} /><span className="text-[12px] text-muted">Checked only, nothing ran</span></div>
          <p className="mt-2 text-[13px] leading-relaxed">{check.explanation}</p>
        </div>
      ) : null}

      {outcome ? <OutcomeCard outcome={outcome} onDecide={decide} busy={busy} /> : null}
    </Panel>
  );
}

function OutcomeCard({ outcome, onDecide, busy }: { outcome: ToolOutcome; onDecide: (approve: boolean) => void; busy: boolean }) {
  const ran = outcome.status === "executed";
  const statusText: Record<ToolOutcome["status"], string> = {
    executed: "Ran",
    denied: "Did not run",
    approval_required: "Waiting for your approval",
    approval_rejected: "Did not run, approval refused",
    failed: "Allowed, but the tool refused",
    invalid: "Not a valid call",
  };
  return (
    <div className={cx("mt-5 rounded-2xl p-4", outcome.status === "approval_required" ? "bg-hold-wash" : "bg-sunken")} aria-live="polite" data-testid="tool-outcome">
      <div className="flex flex-wrap items-center gap-2">
        {outcome.decision ? <DecisionBadge decision={outcome.decision} /> : null}
        <span className={cx("text-[13px] font-medium", ran ? "text-allow" : "text-ink-soft")}>{statusText[outcome.status]}</span>
        {outcome.resource ? <code className="font-mono text-[12px] text-muted">{outcome.resource}</code> : null}
      </div>
      <p className="mt-2 text-[13px] leading-relaxed">{outcome.explanation}</p>
      {outcome.error ? <p className="mt-1 text-[13px] text-deny">{outcome.error}</p> : null}
      {outcome.status === "approval_required" ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="danger" onClick={() => onDecide(false)}>Deny</Button>
          <Button size="sm" variant="primary" busy={busy} onClick={() => onDecide(true)}>Approve and run</Button>
        </div>
      ) : null}
      {outcome.result ? (
        <div className="mt-3 rounded-xl bg-panel p-3 ring-1 ring-line">
          {"content" in outcome.result ? (
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap"><VeiledText text={String(outcome.result.content)} /></p>
          ) : (
            <pre className="overflow-x-auto font-mono text-[12px]">{JSON.stringify(outcome.result, null, 2)}</pre>
          )}
        </div>
      ) : null}
      {outcome.evaluation && outcome.evaluation.matches.length > 1 ? (
        <details className="mt-3 text-[12px] text-muted">
          <summary className="cursor-pointer">All matching policies, in order</summary>
          <ol className="mt-2 flex flex-col gap-1">
            {outcome.evaluation.matches.map((m, i) => (
              <li key={m.id} className={cx(i === 0 && "font-medium text-ink")}>{i + 1}. {m.name} ({m.priority})</li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

// ---- sandbox ---------------------------------------------------------------------------------
function SandboxPanel({ version, onChange }: { version: number; onChange: () => void }) {
  const engine = useEngine();
  const toast = useToast();
  const [files, setFiles] = useState<{ path: string; size: number }[]>([]);
  const [viewing, setViewing] = useState<{ path: string; content: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    void engine.sandbox.list().then(setFiles);
  }, [engine, version]);

  return (
    <Panel>
      <PanelTitle hint="Stored in this browser. Tools can’t reach anything outside it." action={<Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)}>Reset</Button>}>
        Your sandbox
      </PanelTitle>
      <ul className="divide-y divide-line">
        {files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 py-2 text-left hover:text-veil-deep"
              onClick={async () => setViewing({ path: f.path, content: (await engine.sandbox.read(f.path)) ?? "" })}
            >
              <code className="truncate font-mono text-[13px]">{f.path}</code>
              <span className="shrink-0 text-[12px] text-muted tabular">{f.size} chars</span>
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={!!viewing} title={viewing?.path ?? ""} onClose={() => setViewing(null)} footer={<Button onClick={() => setViewing(null)}>Close</Button>}>
        <p className="text-muted">You’re viewing the file directly. Agents only get it through read_file, under your policies.</p>
        <pre className="mt-3 max-h-80 overflow-auto rounded-xl bg-sunken p-3 font-mono text-[12px] whitespace-pre-wrap text-ink">{viewing?.content}</pre>
      </Dialog>
      <ConfirmDialog
        open={confirmReset}
        title="Reset your sandbox?"
        body="All files in your browser sandbox are replaced with the starter files."
        confirmLabel="Reset sandbox"
        onConfirm={async () => {
          await engine.sandbox.seed(true);
          setConfirmReset(false);
          toast("Sandbox reset.");
          onChange();
        }}
        onClose={() => setConfirmReset(false)}
      />
    </Panel>
  );
}

// ---- policies --------------------------------------------------------------------------------
const DECISIONS: { value: Decision; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "approval_required", label: "Needs approval" },
  { value: "deny", label: "Deny" },
];
const EMPTY: Partial<Policy> = { name: "", description: "", agent: "*", action: "file.read", resource: "sandbox:*", decision: "deny", priority: 100, enabled: true };

function PoliciesPanel({ version, onChange }: { version: number; onChange: () => void }) {
  const engine = useEngine();
  const toast = useToast();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [defaultDecision, setDefaultDecision] = useState<Decision>("deny");
  const [editing, setEditing] = useState<Partial<Policy> | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void engine.policies().then((list) => setPolicies([...list].sort((a, b) => b.priority - a.priority)));
    void engine.defaultDecision().then(setDefaultDecision);
  }, [engine, version]);

  async function toggle(p: Policy, enabled: boolean) {
    await engine.savePolicy({ ...p, enabled });
    toast(`${enabled ? "Turned on" : "Turned off"} “${p.name}”.`);
    onChange();
  }

  function exportPolicies() {
    const blob = new Blob([JSON.stringify({ policies, default_decision: defaultDecision }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "privara-policies.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importFile(file: File) {
    const result = await engine.importPolicies(await file.text());
    setImportErrors(result.errors);
    if (!result.errors.length) toast(`Imported ${result.imported} polic${result.imported === 1 ? "y" : "ies"}.`);
    onChange();
  }

  return (
    <Panel className="mt-6" padded={false}>
      <div className="flex flex-col gap-4 p-6 pb-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Your policies</h2>
          <p className="mt-0.5 max-w-xl text-[13px] text-muted">
            Higher priority wins. On a tie, a rule for a specific agent beats a general one, and the stricter decision wins. Saved in this browser.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={() => setEditing({ ...EMPTY })}>New policy</Button>
          <Button size="sm" onClick={exportPolicies}>Export</Button>
          <Button size="sm" onClick={() => fileRef.current?.click()}>Import</Button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" aria-label="Import policies file" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          <Button size="sm" variant="danger" onClick={() => setConfirmReset(true)}>Reset to defaults</Button>
        </div>
      </div>
      {importErrors.length ? (
        <ul role="alert" className="mx-6 mb-4 rounded-xl bg-deny-wash px-3.5 py-2.5 text-[13px] text-deny">
          {importErrors.slice(0, 5).map((e) => <li key={e}>{e}</li>)}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 border-y border-line px-6 py-3 text-[13px]">
        <span className="text-muted">When nothing matches:</span>
        <Segmented
          label="Default decision"
          value={defaultDecision}
          onChange={async (v) => {
            await engine.setDefaultDecision(v);
            toast(v === "deny" ? "Unmatched calls will be denied." : "Unmatched calls will need approval.");
            onChange();
          }}
          options={[{ value: "deny", label: "Deny" }, { value: "approval_required", label: "Needs approval" }]}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-[13px]">
          <caption className="sr-only">Policies in evaluation order</caption>
          <thead className="text-[12px] text-muted">
            <tr className="border-b border-line">
              <th scope="col" className="w-16 py-3 pr-4 pl-6 font-medium">On</th>
              <th scope="col" className="py-3 font-medium">Policy</th>
              <th scope="col" className="py-3 font-medium">Agent</th>
              <th scope="col" className="py-3 font-medium">Decision</th>
              <th scope="col" className="py-3 pr-6 text-right font-medium">Priority</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0">
                <td className="py-3 pr-4 pl-6 align-top"><Switch checked={p.enabled} onChange={(v) => toggle(p, v)} label={`Turn on ${p.name}`} /></td>
                <td className="py-3 pr-4 align-top">
                  <button type="button" className={cx("text-left font-medium hover:underline", !p.enabled && "text-muted")} onClick={() => setEditing({ ...p })}>{p.name}</button>
                  <p className="mt-0.5 text-[12px] text-muted">{actionLabel(p.action)} on <span className="font-mono">{p.resource}</span>{p.builtIn ? ", built in" : ""}</p>
                </td>
                <td className="py-3 pr-4 align-top">{p.agent === "*" ? "Any agent" : p.agent}</td>
                <td className="py-3 pr-4 align-top"><DecisionBadge decision={p.decision} /></td>
                <td className="py-3 pr-6 text-right align-top tabular">{p.priority}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PolicyEditor key={editing?.id ?? (editing ? "new" : "none")} draft={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChange(); }} />
      <ConfirmDialog
        open={confirmReset}
        title="Reset policies?"
        body="Your custom policies are deleted and the built-in ones go back to their original settings."
        confirmLabel="Reset policies"
        onConfirm={async () => {
          await engine.resetPolicies();
          setConfirmReset(false);
          toast("Policies reset to the defaults.");
          onChange();
        }}
        onClose={() => setConfirmReset(false)}
      />
    </Panel>
  );
}

function PolicyEditor({ draft, onClose, onSaved }: { draft: Partial<Policy> | null; onClose: () => void; onSaved: () => void }) {
  const engine = useEngine();
  const toast = useToast();
  const [form, setForm] = useState<Partial<Policy>>(draft ?? EMPTY);
  const [errors, setErrors] = useState<PolicyErrors>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: FormEvent) {
    e.preventDefault();
    const r = await engine.savePolicy({ ...form, priority: Number(form.priority) });
    if (r.errors) return setErrors(r.errors);
    toast(form.id ? "Policy saved. It applies to the next call." : "Policy created. It applies to the next call.");
    onSaved();
  }

  return (
    <>
      <Dialog open={!!draft && !confirmDelete} title={form.id ? "Edit policy" : "New policy"} onClose={onClose}>
        <form onSubmit={save} className="mt-2 flex flex-col gap-3">
          <Field label="Name" error={errors.name}>
            {(id, d) => <input id={id} aria-describedby={d} className={inputClass} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} />}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Agent" hint="* means any agent." error={errors.agent}>
              {(id, d) => <input id={id} aria-describedby={d} className={inputClass} value={form.agent ?? "*"} onChange={(e) => set("agent", e.target.value)} />}
            </Field>
            <Field label="Action" error={errors.action}>
              {(id, d) => (
                <>
                  <input id={id} aria-describedby={d} list="known-actions" className={inputClass + " font-mono"} value={form.action ?? ""} onChange={(e) => set("action", e.target.value)} />
                  <datalist id="known-actions">{Object.keys(KNOWN_ACTIONS).map((a) => <option key={a} value={a} />)}</datalist>
                </>
              )}
            </Field>
          </div>
          <Field label="Resource" hint={`* or start with ${RESOURCE_SCHEMES.join(" ")} — * matches anything.`} error={errors.resource}>
            {(id, d) => <input id={id} aria-describedby={d} className={inputClass + " font-mono"} value={form.resource ?? ""} onChange={(e) => set("resource", e.target.value)} />}
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink-soft">Decision</span>
            <Segmented label="Decision" value={(form.decision ?? "deny") as Decision} onChange={(v) => set("decision", v)} options={DECISIONS} />
          </div>
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <Field label="Priority" hint="0–10000, higher runs first." error={errors.priority}>
              {(id, d) => <input id={id} aria-describedby={d} type="number" className={inputClass + " tabular"} value={form.priority ?? 100} onChange={(e) => set("priority", Number(e.target.value))} />}
            </Field>
            <label className="flex items-center gap-2 pb-6 text-[13px]"><Switch checked={form.enabled ?? true} onChange={(v) => set("enabled", v)} label="Policy on" />On</label>
          </div>
          <div className="mt-2 flex flex-wrap justify-between gap-2">
            {form.id && !form.builtIn ? <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button> : <span />}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary">{form.id ? "Save policy" : "Create policy"}</Button>
            </div>
          </div>
        </form>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this policy?"
        body="Calls it matched will fall through to the next matching policy or the default."
        confirmLabel="Delete policy"
        onConfirm={async () => {
          await engine.deletePolicy(form.id!);
          setConfirmDelete(false);
          toast("Policy deleted.");
          onSaved();
        }}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
}

// ---- history ---------------------------------------------------------------------------------
function HistoryPanel({ version, onChange }: { version: number; onChange: () => void }) {
  const engine = useEngine();
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [open, setOpen] = useState<HistoryEntry | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    void engine.history().then(setItems);
  }, [engine, version]);

  return (
    <Panel className="mt-6">
      <PanelTitle
        hint="Every decision made on this page, kept in this browser. It records what was asked and decided, never file contents or personal values."
        action={items.length ? <Button size="sm" variant="ghost" onClick={() => setConfirmClear(true)}>Clear</Button> : null}
      >
        Decision history
      </PanelTitle>
      {!items.length ? (
        <EmptyState title="No decisions yet">Run a tool call or restore values and each decision appears here.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {items.slice(0, 50).map((h) => (
            <li key={h.id}>
              <button type="button" onClick={() => setOpen(h)} className="-mx-3 flex w-[calc(100%+1.5rem)] items-start gap-4 rounded-2xl px-3 py-2.5 text-left hover:bg-sunken">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium">{actionLabel(h.action)}{h.tool && h.action !== "tool.unregistered" ? <span className="font-normal text-muted"> via {h.tool}</span> : null}</p>
                  <p className="truncate text-[12px] text-muted">{h.agent} on <span className="font-mono">{h.resource}</span></p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <DecisionBadge decision={h.decision} />
                  <span className="text-[12px] text-muted">{OUTCOME_LABEL[h.outcome]}, {relativeTime(h.ts)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!open} title={open ? actionLabel(open.action) : ""} onClose={() => setOpen(null)} footer={<Button onClick={() => setOpen(null)}>Close</Button>}>
        {open ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2"><DecisionBadge decision={open.decision} /><Tag>{OUTCOME_LABEL[open.outcome]}</Tag></div>
            <p className="text-[13px] leading-relaxed text-ink">{open.explanation}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-muted">Agent</dt><dd>{open.agent}</dd>
              <dt className="text-muted">Resource</dt><dd className="font-mono break-all">{open.resource}</dd>
              <dt className="text-muted">When</dt><dd>{new Date(open.ts).toLocaleString()}</dd>
            </dl>
          </div>
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={confirmClear}
        title="Clear decision history?"
        body="The list of decisions on this page is deleted from this browser."
        confirmLabel="Clear history"
        onConfirm={async () => {
          await engine.clearHistory();
          setConfirmClear(false);
          onChange();
        }}
        onClose={() => setConfirmClear(false)}
      />
    </Panel>
  );
}
