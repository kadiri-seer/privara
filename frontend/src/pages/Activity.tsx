import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Approval, type AuditEvent } from "../api";
import { ApprovalsInbox } from "../components/shared";
import {
  Button,
  DecisionBadge,
  Dialog,
  EmptyState,
  ErrorNote,
  OutcomeText,
  PageHeader,
  Panel,
  actionLabel,
  formatTime,
  inputClass,
  outcomeLabel,
} from "../components/ui";

interface Meta {
  agents: { id: string; name: string }[];
  actions: string[];
  decisions: string[];
}

interface Filters {
  q: string;
  agent_id: string;
  action: string;
  decision: string;
  since: string;
  until: string;
}

const PAGE = 25;
const EMPTY: Filters = { q: "", agent_id: "", action: "", decision: "", since: "", until: "" };

function toQuery(f: Filters, offset: number) {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.agent_id) p.set("agent_id", f.agent_id);
  if (f.action) p.set("action", f.action);
  if (f.decision) p.set("decision", f.decision);
  if (f.since) p.set("since", new Date(f.since + "T00:00:00").toISOString());
  if (f.until) p.set("until", new Date(f.until + "T23:59:59.999").toISOString());
  p.set("limit", String(PAGE));
  p.set("offset", String(offset));
  return p.toString();
}

export function Activity() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<AuditEvent | null>(null);

  const load = useCallback(async (f: Filters, offset = 0) => {
    setLoading(true);
    try {
      const data = await api.get<{ items: AuditEvent[]; total: number }>(`/api/admin/activity?${toQuery(f, offset)}`);
      setItems((prev) => (offset ? [...prev, ...data.items] : data.items));
      setTotal(data.total);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(applied);
  }, [applied, load]);
  useEffect(() => {
    api.get<Meta>("/api/admin/activity/meta").then(setMeta).catch(() => setMeta(null));
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    setApplied({ ...filters });
  }
  const setF = (k: keyof Filters, v: string) => {
    const next = { ...filters, [k]: v };
    setFilters(next);
    if (k !== "q") setApplied(next);
  };
  const filtered = JSON.stringify(applied) !== JSON.stringify(EMPTY);

  return (
    <>
      <PageHeader
        title="Activity"
        description="Every decision the gateway made. A decision is not the same as an execution: “Deny” and “Needs approval” mean the action did not run."
      />
      <div className="mb-6">
        <ApprovalsInbox compact onChange={() => load(applied)} />
      </div>
      <form onSubmit={submit} role="search" className="mb-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-full bg-panel p-1.5 pl-5 ring-1 ring-line shadow-[var(--shadow-panel)] focus-within:ring-2 focus-within:ring-veil">
          <svg viewBox="0 0 20 20" className="size-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <circle cx="9" cy="9" r="5.5" />
            <path d="m13.5 13.5 3 3" strokeLinecap="round" />
          </svg>
          <label htmlFor="activity-search" className="sr-only">
            Search activity
          </label>
          <input
            id="activity-search"
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            placeholder="Search by agent, action, resource, explanation or event ID"
            className="h-9 min-w-0 flex-1 bg-transparent text-[15px] focus:outline-none"
            maxLength={100}
          />
          <Button type="submit" variant="primary" size="sm" className="h-9">
            Search
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect label="Agent" value={filters.agent_id} onChange={(v) => setF("agent_id", v)} options={(meta?.agents ?? []).map((a) => ({ value: a.id, label: a.name }))} />
          <FilterSelect label="Action" value={filters.action} onChange={(v) => setF("action", v)} options={(meta?.actions ?? []).map((a) => ({ value: a, label: actionLabel(a) }))} />
          <FilterSelect
            label="Decision"
            value={filters.decision}
            onChange={(v) => setF("decision", v)}
            options={[
              { value: "allow", label: "Allow" },
              { value: "deny", label: "Deny" },
              { value: "approval_required", label: "Needs approval" },
            ]}
          />
          <DateFilter label="From" value={filters.since} onChange={(v) => setF("since", v)} />
          <DateFilter label="To" value={filters.until} onChange={(v) => setF("until", v)} />
          {filtered ? (
            <Button size="sm" variant="ghost" onClick={() => { setFilters(EMPTY); setApplied(EMPTY); }}>
              Clear filters
            </Button>
          ) : null}
          <span className="ml-auto text-[13px] text-muted tabular" aria-live="polite">
            {total} event{total === 1 ? "" : "s"}
          </span>
        </div>
      </form>
      <ErrorNote error={error} />

      <Panel padded={false}>
        {items.length === 0 && !loading ? (
          <div className="p-6">
            <EmptyState title={filtered ? "No events match these filters" : "No activity recorded yet"}>
              {filtered ? "Try removing a filter or widening the date range." : "Events appear as soon as an agent calls the gateway."}
            </EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <caption className="sr-only">Audit events, newest first</caption>
              <thead className="text-[12px] text-muted">
                <tr className="border-b border-line">
                  <th scope="col" className="py-3 pl-6 font-medium">Time</th>
                  <th scope="col" className="py-3 font-medium">Agent</th>
                  <th scope="col" className="py-3 font-medium">Request</th>
                  <th scope="col" className="py-3 font-medium">Decision</th>
                  <th scope="col" className="py-3 pr-6 font-medium">Execution</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0 hover:bg-sunken">
                    <td className="py-3 pl-6 align-top whitespace-nowrap text-muted tabular">{formatTime(e.ts)}</td>
                    <td className="py-3 pr-4 align-top">
                      {e.agent_name ?? "—"}
                      {e.is_demo ? <span className="block text-[12px] text-muted">demo</span> : null}
                    </td>
                    <td className="max-w-[320px] py-3 pr-4 align-top">
                      <button type="button" onClick={() => setOpen(e)} className="text-left font-medium hover:underline">
                        {actionLabel(e.action)}
                        {e.tool_name && e.action !== "tool.unregistered" ? <span className="font-normal text-muted"> via {e.tool_name}</span> : null}
                      </button>
                      {e.resource ? <p className="truncate font-mono text-[12px] text-muted">{e.resource}</p> : null}
                      {e.redaction_count ? <p className="text-[12px] text-veil-deep">{e.redaction_count} redacted</p> : null}
                    </td>
                    <td className="py-3 pr-4 align-top">
                      <DecisionBadge decision={e.decision} />
                    </td>
                    <td className="py-3 pr-6 align-top">
                      <OutcomeText outcome={e.outcome} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {items.length < total ? (
        <div className="mt-4 flex justify-center">
          <Button busy={loading} onClick={() => load(applied, items.length)}>
            Load more
          </Button>
        </div>
      ) : null}
      <EventDetail event={open} onClose={() => setOpen(null)} />
    </>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={"h-8 appearance-none rounded-full pr-8 pl-3.5 text-[13px] ring-1 ring-inset focus:outline-none focus:ring-2 focus:ring-veil " + (value ? "bg-ink text-white ring-ink" : "bg-panel text-ink-soft ring-line hover:ring-line-strong")}
      >
        <option value="">All {label.toLowerCase()}s</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg viewBox="0 0 12 12" className="pointer-events-none absolute top-1/2 right-3 size-2.5 -translate-y-1/2 opacity-60" aria-hidden>
        <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </label>
  );
}

function DateFilter({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[13px] text-muted">
      {label}
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass + " h-8 w-auto rounded-full px-3 text-[13px]"} />
    </label>
  );
}

function EventDetail({ event, onClose }: { event: AuditEvent | null; onClose: () => void }) {
  const [approval, setApproval] = useState<Approval | null>(null);
  useEffect(() => {
    setApproval(null);
    if (!event) return;
    api
      .get<{ approval: Approval | null }>(`/api/admin/activity/${event.id}`)
      .then((d) => setApproval(d.approval))
      .catch(() => setApproval(null));
  }, [event]);
  if (!event) return null;
  return (
    <Dialog open title={actionLabel(event.action)} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-sunken p-3">
            <p className="text-[12px] text-muted">Policy decision</p>
            <div className="mt-1.5">
              <DecisionBadge decision={event.decision} />
            </div>
          </div>
          <div className="rounded-2xl bg-sunken p-3">
            <p className="text-[12px] text-muted">Execution</p>
            <p className="mt-1.5 text-[13px] font-medium">{event.executed ? "Ran" : "Did not run"}</p>
            <p className="text-[12px] text-muted">{outcomeLabel[event.outcome] ?? event.outcome}</p>
          </div>
        </div>
        <div>
          <p className="text-[12px] text-muted">Why</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink">{event.explanation}</p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
          <dt className="text-muted">When</dt>
          <dd>{formatTime(event.ts)}</dd>
          <dt className="text-muted">Agent</dt>
          <dd>
            {event.agent_name} <span className="font-mono text-muted">{event.agent_id}</span>
          </dd>
          <dt className="text-muted">Channel</dt>
          <dd>{({ mcp: "MCP", rest: "REST API", lab: "Privacy Lab", admin: "Dashboard", demo: "Demo run" } as Record<string, string>)[event.channel] ?? event.channel}</dd>
          {event.resource ? (
            <>
              <dt className="text-muted">Resource</dt>
              <dd className="font-mono break-all">{event.resource}</dd>
            </>
          ) : null}
          {event.policy_name ? (
            <>
              <dt className="text-muted">Matched policy</dt>
              <dd>{event.policy_name}</dd>
            </>
          ) : null}
          {event.redaction_count ? (
            <>
              <dt className="text-muted">Sanitization</dt>
              <dd className="flex flex-wrap gap-1">
                {event.redaction_count} redacted:
                {event.entity_categories.map((c) => (
                  <span key={c} className="veil text-[11px]">
                    {c}
                  </span>
                ))}
              </dd>
            </>
          ) : null}
          {event.approval_status ? (
            <>
              <dt className="text-muted">Approval</dt>
              <dd>
                {event.approval_status}
                {approval ? `, request now ${approval.status}` : ""}
                {approval?.decided_by ? `, decided by ${approval.decided_by}` : ""}
              </dd>
            </>
          ) : null}
          <dt className="text-muted">Event ID</dt>
          <dd className="font-mono">{event.id}</dd>
        </dl>
        {event.is_demo ? <p className="rounded-2xl bg-sunken px-3.5 py-2.5 text-[12.5px]">Produced by the built-in demo agent. This is a real gateway decision, not a mock.</p> : null}
        <p className="text-[12px] text-muted">The audit log stores identifiers, counts and categories only. Original values and file contents are never recorded.</p>
      </div>
    </Dialog>
  );
}
