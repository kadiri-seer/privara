import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type DemoResult, type Overview as OverviewData } from "../api";
import { ActivityRow, ApprovalsInbox } from "../components/shared";
import { Button, EmptyState, ErrorNote, PageHeader, Panel, PanelTitle, Tag, VeiledText, cx, useToast } from "../components/ui";
import { useSession } from "../session";

export function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setData(await api.get<OverviewData>("/api/admin/overview"));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const metrics = data
    ? [
        { label: "Registered agents", value: data.registered_agents, note: `${data.active_agents} active` },
        { label: "Values redacted", value: data.redactions, note: "across all sessions" },
        { label: "Actions allowed", value: data.allowed, note: "by policy or approval" },
        { label: "Actions blocked", value: data.blocked, note: "denied before running" },
        { label: "Awaiting approval", value: data.awaiting_approval, note: "need your decision" },
      ]
    : [];

  return (
    <>
      <PageHeader
        title="Overview"
        description="What your agents asked for, what Privara redacted, and what it let through. Every number below comes from the local audit log."
        actions={
          <Link to="/privacy-lab" className="inline-flex h-10 items-center rounded-full bg-ink px-5 text-sm font-medium text-white hover:bg-ink-soft">
            Open Privacy Lab
          </Link>
        }
      />
      <ErrorNote error={error} />
      <Panel padded={false} className="mb-6">
        <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          {(data ? metrics : Array.from({ length: 5 }, (_, i) => ({ label: "", value: null as number | null, note: String(i) }))).map((m, i) => (
            <div
              key={m.label || i}
              className={cx(
                "flex flex-col gap-1 p-5",
                i > 0 && "lg:border-l lg:border-line",
                "border-line max-lg:border-b",
              )}
            >
              <dt className="text-[13px] text-muted">{m.label || " "}</dt>
              <dd className="tabular text-[32px] leading-none font-semibold tracking-[-0.03em]" data-testid={m.label ? `metric-${m.label}` : undefined}>
                {m.value ?? <span className="text-line-strong">—</span>}
              </dd>
              {data ? <dd className="text-[12px] text-muted">{m.note}</dd> : null}
            </div>
          ))}
        </dl>
      </Panel>

      <div className="mb-6">
        <ApprovalsInbox compact onChange={load} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel>
          <PanelTitle action={<Link to="/activity" className="text-[13px] text-veil-deep hover:underline">View all activity</Link>}>
            Recent activity
          </PanelTitle>
          {data && data.recent.length === 0 ? (
            <EmptyState title="No activity yet">
              Connect an agent from Integrations, or run the demo agent to see real decisions appear here.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">{data?.recent.map((e) => <ActivityRow key={e.id} event={e} />)}</ul>
          )}
        </Panel>
        <div className="flex flex-col gap-6">
          <GatewayPanel />
          <DemoPanel onDone={load} />
        </div>
      </div>
    </>
  );
}

function GatewayPanel() {
  const { health, healthError } = useSession();
  return (
    <Panel>
      <PanelTitle hint="Live from /api/health on this machine.">Gateway</PanelTitle>
      {healthError ? (
        <p className="text-sm text-deny">The backend is not responding.</p>
      ) : !health ? (
        <p className="text-sm text-muted">Checking…</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
          {Object.entries(health.checks).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted capitalize">{k}</dt>
              <dd>{v ? <Tag tone="allow">Healthy</Tag> : <Tag tone="deny">Failing</Tag>}</dd>
            </div>
          ))}
          <dt className="text-muted">Detection</dt>
          <dd>{health.detector.mode === "presidio+spacy" ? `Presidio + ${health.detector.model}` : "Presidio patterns only"}</dd>
          <dt className="text-muted">MCP over HTTP</dt>
          <dd>{health.mcp_http ? "Enabled at /mcp" : "Disabled"}</dd>
          <dt className="text-muted">Version</dt>
          <dd className="tabular">{health.version}</dd>
        </dl>
      )}
    </Panel>
  );
}

function DemoPanel({ onDone }: { onDone: () => void }) {
  const [result, setResult] = useState<DemoResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<DemoResult>("/api/admin/demo/run");
      setResult(r);
      toast(r.all_passed ? "Demo finished. Every step behaved as expected." : "Demo finished with unexpected results.", r.all_passed ? "ok" : "error");
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <PanelTitle hint="A built-in agent connects over MCP and tries eight things — some allowed, some blocked, one needing approval.">
        Demo agent
      </PanelTitle>
      <Button variant="accent" busy={busy} onClick={run} className="w-full">
        {result ? "Run the demo again" : "Run the demo"}
      </Button>
      <ErrorNote error={error} />
      {result ? (
        <ol className="mt-5 flex flex-col gap-3" aria-label="Demo steps">
          {result.steps.map((s) => (
            <li key={s.step} className="flex gap-3">
              <span
                className={cx(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular",
                  s.passed ? "bg-ink text-white" : "bg-deny text-white",
                )}
              >
                {s.step}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{s.title}</p>
                <p className="text-[12px] text-muted">
                  {s.status.replace("_", " ")} {s.passed ? "as expected" : `(expected ${s.expected})`}
                </p>
                {s.sanitized_text ? (
                  <p className="mt-1.5 text-[13px] leading-relaxed">
                    <VeiledText text={s.sanitized_text} animate />
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-[12px] text-muted">The approval step is performed by the demo through the same operator code path you use, and is labelled in Activity.</p>
      )}
    </Panel>
  );
}
