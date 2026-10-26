import { useCallback, useEffect, useState } from "react";
import { api, type Approval, type AuditEvent } from "../api";
import { Button, DecisionBadge, EmptyState, ErrorNote, OutcomeText, Panel, PanelTitle, Tag, actionLabel, relativeTime, useToast } from "./ui";

export function ActivityRow({ event, onOpen }: { event: AuditEvent; onOpen?: (e: AuditEvent) => void }) {
  const content = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[14px] font-medium">{actionLabel(event.action)}</span>
          {event.tool_name && event.action !== "tool.unregistered" ? <span className="text-[13px] text-muted">via {event.tool_name}</span> : null}
          {event.is_demo ? <Tag>Demo agent</Tag> : null}
        </div>
        <p className="mt-0.5 truncate text-[13px] text-muted">
          {event.agent_name ?? "unknown agent"}
          {event.resource ? <> on <span className="font-mono text-[12px]">{event.resource}</span></> : null}
          {event.redaction_count ? <> — {event.redaction_count} value{event.redaction_count === 1 ? "" : "s"} redacted</> : null}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <DecisionBadge decision={event.decision} />
        <span className="text-[12px] text-muted">
          <OutcomeText outcome={event.outcome} />, {relativeTime(event.ts)}
        </span>
      </div>
    </>
  );
  if (!onOpen) return <li className="flex items-start gap-4 py-3">{content}</li>;
  return (
    <li>
      <button type="button" onClick={() => onOpen(event)} className="-mx-3 flex w-[calc(100%+1.5rem)] items-start gap-4 rounded-2xl px-3 py-3 text-left hover:bg-sunken">
        {content}
      </button>
    </li>
  );
}

export function ApprovalsInbox({ onChange, compact = false }: { onChange?: () => void; compact?: boolean }) {
  const [items, setItems] = useState<Approval[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ items: Approval[] }>("/api/admin/approvals?status=pending");
      setItems(data.items);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    try {
      await api.post(`/api/admin/approvals/${id}/${approve ? "approve" : "deny"}`);
      toast(approve ? "Approved. The agent can now collect its one-time token." : "Denied. The action will not run.");
      await load();
      onChange?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not record the decision.", "error");
    } finally {
      setBusy(null);
    }
  }

  if (compact && !items.length && !error) return null;
  return (
    <Panel>
      <PanelTitle hint="Agents wait here until you decide. Approval issues a single-use token bound to the exact request.">
        Awaiting your approval
      </PanelTitle>
      <ErrorNote error={error} />
      {items.length === 0 ? (
        <EmptyState title="Nothing is waiting">Requests that match an approval-required policy will appear here.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((a) => (
            <li key={a.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium">
                  {actionLabel(a.action)} <span className="font-normal text-muted">on</span> <span className="font-mono text-[12.5px]">{a.resource}</span>
                </p>
                <p className="mt-0.5 text-[12px] text-muted">
                  Requested by {a.agent_id} {relativeTime(a.created_at)}
                  {typeof a.summary.content_length === "number" ? `, ${a.summary.content_length} characters` : ""}
                  {a.is_demo ? ", demo agent" : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="danger" busy={busy === a.id} onClick={() => decide(a.id, false)}>
                  Deny
                </Button>
                <Button size="sm" variant="primary" busy={busy === a.id} onClick={() => decide(a.id, true)}>
                  Approve
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
