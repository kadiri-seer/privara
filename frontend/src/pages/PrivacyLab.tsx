import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type RestoreResult, type SanitizeResult } from "../api";
import {
  Button,
  ConfirmDialog,
  CopyButton,
  ErrorNote,
  PageHeader,
  Panel,
  PanelTitle,
  Segmented,
  Tag,
  VeiledText,
  cx,
  useToast,
} from "../components/ui";

const SAMPLE = "Send John Okafor the invoice for ₦250,000 at john@example.com. If he doesn't reply by Friday, call him on 0803 123 4567.";
const SESSION_KEY = "privara.labSession";

function newSessionId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return "lab-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function loadSessionId() {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const created = newSessionId();
    sessionStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    return newSessionId();
  }
}

interface Category {
  id: string;
  label: string;
}

export function PrivacyLab() {
  const [text, setText] = useState("");
  const [sessionId, setSessionId] = useState(loadSessionId);
  const [level, setLevel] = useState<"low" | "medium" | "high">("medium");
  const [categories, setCategories] = useState<Category[]>([]);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [result, setResult] = useState<SanitizeResult | null>(null);
  const [sourceText, setSourceText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [restore, setRestore] = useState<RestoreResult | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [showOriginals, setShowOriginals] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api
      .get<{ settings: { default_categories: string[]; detection_level: "low" | "medium" | "high" }; categories: Category[] }>("/api/admin/settings")
      .then((s) => {
        setCategories(s.categories);
        setSelected(s.settings.default_categories);
        setLevel(s.settings.detection_level);
      })
      .catch(() => setSelected(null));
  }, []);

  async function sanitize() {
    setBusy(true);
    setError(null);
    setRestore(null);
    setShowOriginals(false);
    try {
      const r = await api.post<SanitizeResult>("/api/admin/lab/sanitize", {
        text,
        session_id: sessionId,
        sensitivity: { level, ...(selected ? { categories: selected } : {}) },
      });
      if (r.status !== "sanitized") throw new Error(r.explanation ?? "Sanitization was not permitted.");
      setResult(r);
      setSourceText(text);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function requestRestore(approvalRequestId?: string) {
    if (!result) return;
    setRestoreBusy(true);
    try {
      if (approvalRequestId) await api.post(`/api/admin/approvals/${approvalRequestId}/approve`);
      const r = await api.post<RestoreResult>("/api/admin/lab/restore", {
        text: result.sanitized_text,
        redaction_session_id: result.redaction_session_id,
        ...(approvalRequestId ? { approval_request_id: approvalRequestId } : {}),
      });
      setRestore(r);
      if (r.status === "restored") {
        setShowOriginals(true);
        toast(`Restored ${r.restored_count} value${r.restored_count === 1 ? "" : "s"}. The one-time token has been used.`);
      } else if (r.status === "denied") {
        toast("Restoration is denied by policy.", "error");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Restore failed.", "error");
    } finally {
      setRestoreBusy(false);
    }
  }

  async function denyRestore(id: string) {
    try {
      await api.post(`/api/admin/approvals/${id}/deny`);
      setRestore({ status: "denied", explanation: "You denied this restoration request." });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not deny.", "error");
    }
  }

  async function clearSession() {
    try {
      if (result) await api.del(`/api/admin/sessions/${result.redaction_session_id}`);
      const fresh = newSessionId();
      try {
        sessionStorage.setItem(SESSION_KEY, fresh);
      } catch {
        /* ignore */
      }
      setSessionId(fresh);
      setResult(null);
      setRestore(null);
      setShowOriginals(false);
      toast("Session cleared. Its stored mappings were deleted.");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not clear the session.", "error");
    } finally {
      setConfirmClear(false);
    }
  }

  const highlighted = useMemo(() => {
    if (!result?.entities || !sourceText) return null;
    const nodes: ReactNode[] = [];
    let cursor = 0;
    result.entities.forEach((e, i) => {
      nodes.push(<span key={`t${i}`}>{sourceText.slice(cursor, e.start)}</span>);
      nodes.push(
        <mark key={`m${i}`} className="mark-original bg-transparent text-ink" title={`${e.category} → ${e.placeholder}`}>
          {sourceText.slice(e.start, e.end)}
        </mark>,
      );
      cursor = e.end;
    });
    nodes.push(<span key="end">{sourceText.slice(cursor)}</span>);
    return nodes;
  }, [result, sourceText]);

  const restored = restore?.status === "restored" ? restore.restored_text ?? "" : null;

  return (
    <>
      <PageHeader
        title="Privacy Lab"
        description="Paste anything an agent might send out. Privara detects personal and financial details locally and replaces them with placeholders it can reverse only with your approval."
      />

      <Panel className="mb-6">
        <label htmlFor="lab-input" className="sr-only">
          Text to sanitize
        </label>
        <textarea
          id="lab-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder="Paste text with names, emails, phone numbers or amounts…"
          className="w-full resize-y rounded-2xl bg-sunken p-4 text-[15px] leading-relaxed ring-1 ring-inset ring-line placeholder:text-muted/70 focus:bg-panel focus:outline-none focus:ring-2 focus:ring-veil"
        />
        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label="Detection sensitivity: fewer matches, balanced, or catch more"
              value={level}
              onChange={setLevel}
              options={[
                { value: "low", label: "Fewer" },
                { value: "medium", label: "Balanced" },
                { value: "high", label: "More" },
              ]}
            />
            <button type="button" onClick={() => setText(SAMPLE)} className="text-[13px] text-veil-deep hover:underline">
              Use sample text
            </button>
          </div>
          <Button variant="primary" onClick={sanitize} busy={busy} disabled={!text.trim()}>
            Sanitize
          </Button>
        </div>
        {categories.length && selected ? (
          <fieldset className="mt-4 border-t border-line pt-4">
            <legend className="sr-only">Categories to detect</legend>
            <div className="flex flex-wrap gap-1.5">
              {categories.map((c) => {
                const on = selected.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setSelected(on ? selected.filter((x) => x !== c.id) : [...selected, c.id])}
                    className={cx(
                      "h-7 rounded-full px-3 text-[12px] font-medium ring-1 ring-inset transition-colors",
                      on ? "bg-veil-wash text-veil-deep ring-veil-line" : "bg-panel text-muted ring-line hover:text-ink",
                    )}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : null}
        <div className="mt-4">
          <ErrorNote error={error} />
        </div>
      </Panel>

      {result ? (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel>
              <PanelTitle hint="Highlighted spans were detected. This text never left your machine.">Original</PanelTitle>
              <p className="text-[15px] leading-[1.8] whitespace-pre-wrap" data-testid="original-view">
                {highlighted}
              </p>
            </Panel>
            <Panel className="ring-veil-line">
              <PanelTitle
                hint={showOriginals ? "Showing values restored through the approval flow." : "Safe to send to an external model or tool."}
                action={
                  <div className="flex gap-1">
                    {restored !== null ? (
                      <Button size="sm" variant="ghost" onClick={() => setShowOriginals((v) => !v)} aria-pressed={showOriginals}>
                        {showOriginals ? "Hide originals" : "Show originals"}
                      </Button>
                    ) : null}
                    <CopyButton value={result.sanitized_text} label="Copy sanitized" />
                  </div>
                }
              >
                Sanitized
              </PanelTitle>
              <p className="text-[15px] leading-[1.8] whitespace-pre-wrap" data-testid="sanitized-view">
                {showOriginals && restored !== null ? restored : <VeiledText text={result.sanitized_text} animate />}
              </p>
            </Panel>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Panel>
              <PanelTitle hint={`${result.redaction_count} value${result.redaction_count === 1 ? "" : "s"} redacted, ${result.placeholders.length} distinct.`}>
                What was found
              </PanelTitle>
              {result.redaction_count === 0 ? (
                <p className="text-sm text-muted">Nothing matched the selected categories at this sensitivity.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {Object.entries(result.category_counts).map(([cat, count]) => (
                    <li key={cat} className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="flex flex-wrap gap-1.5">
                        {result.placeholders
                          .filter((p) => p.category === cat)
                          .map((p) => (
                            <span key={p.placeholder} className="veil">
                              {p.placeholder.slice(1, -1)}
                            </span>
                          ))}
                      </span>
                      <span className="tabular text-muted">{count}×</span>
                    </li>
                  ))}
                </ul>
              )}
              <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-line pt-4 text-[12px]">
                <dt className="text-muted">Redaction session</dt>
                <dd className="truncate font-mono">{result.redaction_session_id}</dd>
                <dt className="text-muted">Detector</dt>
                <dd>{result.detector.mode === "presidio+spacy" ? `Presidio + ${result.detector.model}` : "Presidio patterns only"}</dd>
                <dt className="text-muted">Score threshold</dt>
                <dd className="tabular">{result.threshold}</dd>
              </dl>
            </Panel>

            <Panel>
              <PanelTitle hint="Restoring re-identifies people. By default each restore needs a one-time approval.">Restore values</PanelTitle>
              <RestoreState
                restore={restore}
                busy={restoreBusy}
                onRequest={() => requestRestore()}
                onApprove={(id) => requestRestore(id)}
                onDeny={denyRestore}
              />
              <div className="mt-5 border-t border-line pt-4">
                <Button size="sm" variant="danger" onClick={() => setConfirmClear(true)}>
                  Clear session data
                </Button>
              </div>
            </Panel>
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmClear}
        title="Clear this session?"
        body="Privara deletes the stored mapping between placeholders and original values. Text sanitized in this session can no longer be restored."
        confirmLabel="Clear session"
        onConfirm={clearSession}
        onClose={() => setConfirmClear(false)}
      />
    </>
  );
}

function RestoreState({
  restore,
  busy,
  onRequest,
  onApprove,
  onDeny,
}: {
  restore: RestoreResult | null;
  busy: boolean;
  onRequest: () => void;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  if (!restore) {
    return (
      <Button onClick={onRequest} busy={busy}>
        Request restore
      </Button>
    );
  }
  if (restore.status === "approval_required" && restore.approval_request_id) {
    return (
      <div className="rounded-2xl bg-hold-wash p-4">
        <p className="text-[13px] font-medium text-hold">Approval needed</p>
        <p className="mt-1 text-[13px] text-ink-soft">{restore.explanation}</p>
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="danger" onClick={() => onDeny(restore.approval_request_id!)}>
            Deny
          </Button>
          <Button size="sm" variant="primary" busy={busy} onClick={() => onApprove(restore.approval_request_id!)}>
            Approve and restore
          </Button>
        </div>
      </div>
    );
  }
  if (restore.status === "restored") {
    return (
      <div className="flex flex-col items-start gap-2 text-[13px]">
        <Tag tone="allow">Restored {restore.restored_count} value{restore.restored_count === 1 ? "" : "s"}</Tag>
        <p className="text-muted">{restore.explanation}</p>
        <Button size="sm" onClick={onRequest} busy={busy} className="self-start">
          Request again
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2 text-[13px]">
      <Tag tone="deny">Not restored</Tag>
      <p className="text-muted">{restore.explanation ?? restore.message}</p>
      <Button size="sm" onClick={onRequest} busy={busy} className="self-start">
        Request again
      </Button>
    </div>
  );
}
