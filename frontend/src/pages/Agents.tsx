import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError, api, type Agent, type AuditEvent, type Policy } from "../api";
import { useSession } from "../session";
import {
  Button,
  CodeBlock,
  ConfirmDialog,
  DecisionBadge,
  EmptyState,
  ErrorNote,
  Field,
  PageHeader,
  Panel,
  PanelTitle,
  SecretDialog,
  Tag,
  actionLabel,
  cx,
  formatTime,
  inputClass,
  relativeTime,
  useToast,
} from "../components/ui";

interface Scopes {
  agent: Agent;
  policies: Policy[];
  default_decision: string;
  last_activity: AuditEvent | null;
}

export function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ items: Agent[] }>("/api/admin/agents");
      setAgents(data.items);
      setError(null);
      setSelectedId((current) => current ?? data.items.find((a) => !a.is_system)?.id ?? data.items[0]?.id ?? null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const external = agents.filter((a) => !a.is_system);
  const builtIn = agents.filter((a) => a.is_system);

  return (
    <>
      <PageHeader
        title="Agent Access"
        description="Each agent connects with its own key. Revoking or rotating a key takes effect on the agent’s very next request."
        actions={
          <Button variant="primary" onClick={() => setShowForm((v) => !v)} aria-expanded={showForm}>
            Register agent
          </Button>
        }
      />
      <ErrorNote error={error} />
      {showForm ? (
        <RegisterForm
          onCancel={() => setShowForm(false)}
          onCreated={(agent, key) => {
            setShowForm(false);
            setSecret(key);
            setSelectedId(agent.id);
            void load();
          }}
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Panel padded={false} className="p-3">
            <h2 className="px-3 pt-2 pb-1 text-[13px] font-medium text-muted">Your agents</h2>
            {external.length === 0 ? (
              <div className="p-3">
                <EmptyState title="No agents yet">Register one to get a key for MCP or REST access.</EmptyState>
              </div>
            ) : (
              <AgentList agents={external} selectedId={selectedId} onSelect={setSelectedId} />
            )}
            <h2 className="px-3 pt-4 pb-1 text-[13px] font-medium text-muted">Built in</h2>
            <AgentList agents={builtIn} selectedId={selectedId} onSelect={setSelectedId} />
          </Panel>
        </div>
        {selectedId ? <AgentDetail key={selectedId} agentId={selectedId} onChanged={load} onSecret={setSecret} /> : null}
      </div>
      <SecretDialog secret={secret} title="Agent key created" onClose={() => setSecret(null)} />
    </>
  );
}

function AgentList({ agents, selectedId, onSelect }: { agents: Agent[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {agents.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => onSelect(a.id)}
            aria-current={selectedId === a.id}
            className={cx(
              "flex w-full items-center justify-between gap-3 rounded-2xl px-3 py-2.5 text-left",
              selectedId === a.id ? "bg-sunken ring-1 ring-line" : "hover:bg-sunken",
            )}
          >
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-medium">{a.name}</span>
              <span className="block text-[12px] text-muted">Last seen {relativeTime(a.last_seen_at)}</span>
            </span>
            <Tag tone={a.status === "active" ? "allow" : "deny"}>{a.status === "active" ? "Active" : "Revoked"}</Tag>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RegisterForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (a: Agent, key: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ agent: Agent; api_key: string }>("/api/admin/agents", { name, description });
      onCreated(r.agent, r.api_key);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel className="mb-6">
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-[1fr_2fr_auto] md:items-end">
        <Field label="Name" hint="Letters, digits, spaces, dots, dashes.">
          {(id, d) => <input id={id} aria-describedby={d} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="research-assistant" required />}
        </Field>
        <Field label="Description" hint="Optional. What this agent does.">
          {(id, d) => <input id={id} aria-describedby={d} className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <div className="flex gap-2 md:pb-5">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={name.trim().length < 2}>
            Create key
          </Button>
        </div>
      </form>
      <div className="mt-2">
        <ErrorNote error={error} />
      </div>
    </Panel>
  );
}

function AgentDetail({ agentId, onChanged, onSecret }: { agentId: string; onChanged: () => void; onSecret: (k: string) => void }) {
  const [scopes, setScopes] = useState<Scopes | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<"revoke" | "rotate" | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { hosted } = useSession();

  const load = useCallback(async () => {
    try {
      setScopes(await api.get<Scopes>(`/api/admin/agents/${agentId}/scopes`));
    } catch (err) {
      setError(err);
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(kind: "revoke" | "rotate" | "reactivate") {
    setBusy(true);
    try {
      const r = await api.post<{ api_key?: string; expired_approvals?: number }>(`/api/admin/agents/${agentId}/${kind}`);
      if (kind === "rotate" && r.api_key) onSecret(r.api_key);
      toast(
        kind === "revoke"
          ? `Access revoked.${r.expired_approvals ? ` ${r.expired_approvals} open approval(s) expired.` : ""}`
          : kind === "rotate"
            ? "Key rotated. The old key no longer works."
            : "Access restored.",
      );
      await load();
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Action failed.", "error");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  if (error) return <ErrorNote error={error} />;
  if (!scopes) return <Panel><p className="text-sm text-muted">Loading…</p></Panel>;
  const { agent } = scopes;
  const isLab = agent.id === "agt_privacy_lab";

  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-semibold tracking-[-0.02em]">{agent.name}</h2>
              <Tag tone={agent.status === "active" ? "allow" : "deny"}>{agent.status === "active" ? "Active" : "Revoked"}</Tag>
            </div>
            <p className="mt-1 text-[13px] text-muted">{agent.description || "No description."}</p>
          </div>
          {!agent.is_system ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setConfirm("rotate")}>
                Rotate key
              </Button>
              {agent.status === "active" ? (
                <Button size="sm" variant="danger" onClick={() => setConfirm("revoke")}>
                  Revoke access
                </Button>
              ) : (
                <Button size="sm" variant="primary" busy={busy} onClick={() => act("reactivate")}>
                  Restore access
                </Button>
              )}
            </div>
          ) : null}
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-4 text-[13px] sm:grid-cols-4">
          <div>
            <dt className="text-muted">Agent ID</dt>
            <dd className="mt-0.5 truncate font-mono text-[12px]">{agent.id}</dd>
          </div>
          <div>
            <dt className="text-muted">Created</dt>
            <dd className="mt-0.5">{formatTime(agent.created_at)}</dd>
          </div>
          <div>
            <dt className="text-muted">Key rotated</dt>
            <dd className="mt-0.5">{isLab ? "No key (internal)" : formatTime(agent.key_rotated_at)}</dd>
          </div>
          <div>
            <dt className="text-muted">Last activity</dt>
            <dd className="mt-0.5">
              {scopes.last_activity ? `${actionLabel(scopes.last_activity.action)}, ${relativeTime(scopes.last_activity.ts)}` : "None yet"}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel>
        <PanelTitle
          hint={`Evaluated top to bottom; the first enabled match wins. Anything unmatched is ${scopes.default_decision === "deny" ? "denied" : "sent for approval"}.`}
          action={<Link to="/policies" className="text-[13px] text-veil-deep hover:underline">Edit policies</Link>}
        >
          Permission scopes
        </PanelTitle>
        <ul className="divide-y divide-line">
          {scopes.policies.map((p) => (
            <li key={p.id} className={cx("flex items-center gap-3 py-2.5", !p.enabled && "opacity-50")}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{p.name}</p>
                <p className="truncate text-[12px] text-muted">
                  {actionLabel(p.action)} on <span className="font-mono">{p.resource}</span>
                  {p.scope === "agent" ? ", this agent only" : ""}
                  {!p.enabled ? ", disabled" : ""}
                </p>
              </div>
              <DecisionBadge decision={p.decision} />
            </li>
          ))}
        </ul>
      </Panel>

      {!agent.is_system ? (
        <Panel>
          <PanelTitle hint="Use this agent’s key in place of the placeholder. Full options are on the Integrations page.">Connect over MCP</PanelTitle>
          <CodeBlock
            label={hosted ? "MCP client config (streamable HTTP)" : "Claude Desktop / MCP client config"}
            code={JSON.stringify(
              hosted
                ? { mcpServers: { privara: { type: "http", url: `${window.location.origin}/mcp`, headers: { Authorization: `Bearer <${agent.name} key>` } } } }
                : {
                    mcpServers: {
                      privara: {
                        command: "uv",
                        args: ["--directory", "/path/to/privara/backend", "run", "privara", "mcp"],
                        env: { PRIVARA_AGENT_KEY: `<${agent.name} key>` },
                      },
                    },
                  },
              null,
              2,
            )}
          />
        </Panel>
      ) : null}

      <ConfirmDialog
        open={confirm === "revoke"}
        title={`Revoke ${agent.name}?`}
        body="The agent’s next request will be refused, and any approvals it is waiting on will expire. You can restore access later; the key stays the same."
        confirmLabel="Revoke access"
        busy={busy}
        onConfirm={() => act("revoke")}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "rotate"}
        title={`Rotate ${agent.name}’s key?`}
        body="A new key is generated and shown once. The current key stops working immediately, so update the agent’s configuration right away."
        confirmLabel="Rotate key"
        busy={busy}
        onConfirm={() => act("rotate")}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
