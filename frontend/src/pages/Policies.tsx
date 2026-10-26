import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, api, type Agent, type Decision, type Policy } from "../api";
import {
  Button,
  ConfirmDialog,
  DecisionBadge,
  ErrorNote,
  Field,
  PageHeader,
  Panel,
  PanelTitle,
  Segmented,
  Switch,
  Tag,
  actionLabel,
  cx,
  inputClass,
  useToast,
} from "../components/ui";

interface PolicyList {
  items: Policy[];
  actions: Record<string, string>;
  resource_schemes: string[];
  default_decision: string;
}

interface Draft {
  id?: string;
  name: string;
  description: string;
  agent_id: string;
  action: string;
  resource: string;
  decision: Decision;
  priority: number;
  enabled: boolean;
  origin?: string;
}

const EMPTY: Draft = { name: "", description: "", agent_id: "*", action: "file.read", resource: "sandbox:*", decision: "deny", priority: 100, enabled: true };
const DECISIONS: { value: Decision; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "approval_required", label: "Require approval" },
  { value: "deny", label: "Deny" },
];

export function Policies() {
  const [data, setData] = useState<PolicyList | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([api.get<PolicyList>("/api/admin/policies"), api.get<{ items: Agent[] }>("/api/admin/agents")]);
      setData(p);
      setAgents(a.items);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(policy: Policy, enabled: boolean) {
    try {
      await api.patch(`/api/admin/policies/${policy.id}`, { enabled });
      toast(enabled ? `Enabled “${policy.name}”.` : `Disabled “${policy.name}”.`);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update.", "error");
    }
  }

  const agentName = (id: string) => (id === "*" ? "Any agent" : agents.find((a) => a.id === id)?.name ?? id);

  return (
    <>
      <PageHeader
        title="Policies"
        description={
          <>
            Rules the gateway enforces on every request. Higher priority wins; on a tie, an agent-specific rule beats a general one, and the stricter decision wins.
            Requests that match nothing are {data?.default_decision === "approval_required" ? "sent for approval" : "denied"}.
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setDraft({ ...EMPTY })}>
            New policy
          </Button>
        }
      />
      <ErrorNote error={error} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <caption className="sr-only">Policies, in evaluation order</caption>
              <thead className="text-[12px] text-muted">
                <tr className="border-b border-line">
                  <th scope="col" className="py-3 pl-6 font-medium">On</th>
                  <th scope="col" className="py-3 font-medium">Policy</th>
                  <th scope="col" className="py-3 font-medium">Applies to</th>
                  <th scope="col" className="py-3 font-medium">Decision</th>
                  <th scope="col" className="py-3 pr-6 text-right font-medium">Priority</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((p) => (
                  <tr key={p.id} className={cx("border-b border-line last:border-0", draft?.id === p.id && "bg-sunken")}>
                    <td className="w-16 py-3 pr-4 pl-6 align-top">
                      <Switch checked={p.enabled} onChange={(v) => toggle(p, v)} label={`Enable ${p.name}`} />
                    </td>
                    <td className="py-3 pr-4 align-top">
                      <button type="button" onClick={() => setDraft({ ...p })} className={cx("text-left font-medium hover:underline", !p.enabled && "text-muted")}>
                        {p.name}
                      </button>
                      <p className="mt-0.5 text-[12px] text-muted">
                        {actionLabel(p.action)} on <span className="font-mono">{p.resource}</span>
                      </p>
                    </td>
                    <td className="py-3 pr-4 align-top">
                      {agentName(p.agent_id)}
                      {p.origin === "seed" ? <span className="block text-[12px] text-muted">Built in</span> : null}
                    </td>
                    <td className="py-3 pr-4 align-top">
                      <DecisionBadge decision={p.decision} />
                    </td>
                    <td className="tabular py-3 pr-6 text-right align-top">{p.priority}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="flex flex-col gap-6">
          {draft ? (
            <PolicyEditor
              key={draft.id ?? "new"}
              draft={draft}
              agents={agents}
              actions={data?.actions ?? {}}
              schemes={data?.resource_schemes ?? []}
              onClose={() => setDraft(null)}
              onSaved={async () => {
                setDraft(null);
                await load();
              }}
            />
          ) : null}
          <ExplainPanel agents={agents} actions={data?.actions ?? {}} />
        </div>
      </div>
    </>
  );
}

function PolicyEditor({
  draft,
  agents,
  actions,
  schemes,
  onClose,
  onSaved,
}: {
  draft: Draft;
  agents: Agent[];
  actions: Record<string, string>;
  schemes: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Draft>(draft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toast = useToast();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setError(null);
    const body = {
      name: form.name,
      description: form.description,
      agent_id: form.agent_id,
      action: form.action,
      resource: form.resource,
      decision: form.decision,
      priority: Number(form.priority),
      enabled: form.enabled,
    };
    try {
      if (form.id) await api.patch(`/api/admin/policies/${form.id}`, body);
      else await api.post("/api/admin/policies", body);
      toast(form.id ? "Policy saved. It applies to the next request." : "Policy created. It applies to the next request.");
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.details) {
        const map: Record<string, string> = {};
        err.details.forEach((d) => {
          if (d.field) map[d.field] = d.message ?? d.error ?? "Invalid value";
        });
        setErrors(map);
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      await api.del(`/api/admin/policies/${form.id}`);
      toast("Policy deleted.");
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setConfirmDelete(false);
    }
  }

  return (
    <Panel>
      <PanelTitle hint={form.origin === "seed" ? "Built-in policy. You can change or disable it, but not delete it." : undefined}>
        {form.id ? "Edit policy" : "New policy"}
      </PanelTitle>
      <form onSubmit={save} className="flex flex-col gap-4">
        <Field label="Name" error={errors.name}>
          {(id, d) => <input id={id} aria-describedby={d} className={inputClass} value={form.name} onChange={(e) => set("name", e.target.value)} required />}
        </Field>
        <Field label="Agent" error={errors.agent_id}>
          {(id, d) => (
            <select id={id} aria-describedby={d} className={inputClass} value={form.agent_id} onChange={(e) => set("agent_id", e.target.value)}>
              <option value="*">Any agent</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Action" hint={actions[form.action] ?? "Wildcards like file.* are allowed."} error={errors.action}>
          {(id, d) => (
            <>
              <input id={id} aria-describedby={d} list="known-actions" className={inputClass + " font-mono"} value={form.action} onChange={(e) => set("action", e.target.value)} required />
              <datalist id="known-actions">
                {Object.keys(actions).map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Resource scope" hint={`'*' or start with ${schemes.join(" ")}. * matches anything, including /.`} error={errors.resource}>
          {(id, d) => <input id={id} aria-describedby={d} className={inputClass + " font-mono"} value={form.resource} onChange={(e) => set("resource", e.target.value)} required />}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-ink-soft">Decision</span>
          <Segmented label="Decision" value={form.decision} onChange={(v) => set("decision", v)} options={DECISIONS} />
        </div>
        <div className="grid grid-cols-[1fr_auto] items-end gap-4">
          <Field label="Priority" hint="0–10000. Higher runs first." error={errors.priority}>
            {(id, d) => (
              <input id={id} aria-describedby={d} type="number" min={0} max={10000} className={inputClass + " tabular"} value={form.priority} onChange={(e) => set("priority", Number(e.target.value))} />
            )}
          </Field>
          <div className="flex items-center gap-2 pb-6">
            <Switch checked={form.enabled} onChange={(v) => set("enabled", v)} label="Policy enabled" />
            <span className="text-[13px]">Enabled</span>
          </div>
        </div>
        <Field label="Description" hint="Optional. Shown in explanations.">
          {(id, d) => <textarea id={id} aria-describedby={d} rows={2} className={inputClass + " h-auto py-2.5"} value={form.description} onChange={(e) => set("description", e.target.value)} />}
        </Field>
        <ErrorNote error={error} />
        <div className="flex flex-wrap justify-between gap-2">
          {form.id && form.origin === "user" ? (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              {form.id ? "Save policy" : "Create policy"}
            </Button>
          </div>
        </div>
      </form>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this policy?"
        body="Requests it matched will fall through to the next matching policy or the default decision."
        confirmLabel="Delete policy"
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      />
    </Panel>
  );
}

interface Explanation {
  decision: Decision;
  explanation: string;
  default_applied: boolean;
  matches: { id: string; name: string; decision: Decision; priority: number }[];
}

function ExplainPanel({ agents, actions }: { agents: Agent[]; actions: Record<string, string> }) {
  const [agentId, setAgentId] = useState("*");
  const [action, setAction] = useState("file.write");
  const [resource, setResource] = useState("sandbox:outbox/report.txt");
  const [result, setResult] = useState<Explanation | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function explain(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setResult(await api.post<Explanation>("/api/admin/policies/explain", { agent_id: agentId, action, resource }));
    } catch (err) {
      setError(err);
      setResult(null);
    }
  }

  return (
    <Panel>
      <PanelTitle hint="Check how a request would be decided. This is a simulation — nothing runs and nothing is logged.">Explain a decision</PanelTitle>
      <form onSubmit={explain} className="flex flex-col gap-3">
        <Field label="Agent">
          {(id) => (
            <select id={id} className={inputClass} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="*">Any agent</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Action">
          {(id) => (
            <select id={id} className={inputClass} value={action} onChange={(e) => setAction(e.target.value)}>
              {Object.keys(actions).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Resource">
          {(id) => <input id={id} className={inputClass + " font-mono"} value={resource} onChange={(e) => setResource(e.target.value)} />}
        </Field>
        <Button type="submit">Explain</Button>
      </form>
      <ErrorNote error={error} />
      {result ? (
        <div className="mt-4 rounded-2xl bg-sunken p-4" aria-live="polite">
          <DecisionBadge decision={result.decision} />
          <p className="mt-2 text-[13px] leading-relaxed">{result.explanation}</p>
          {result.matches.length > 1 ? (
            <ol className="mt-3 flex flex-col gap-1 text-[12px] text-muted">
              {result.matches.map((m, i) => (
                <li key={m.id} className={cx(i === 0 && "font-medium text-ink")}>
                  {i + 1}. {m.name} <Tag>{m.priority}</Tag>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
