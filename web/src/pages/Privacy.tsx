import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { DocumentChip, DownloadButtons, DropTarget, UploadButton } from "../components/documents";
import { CATEGORIES, DEFAULT_CATEGORIES, type Category, type Sensitivity } from "../engine/detect";
import { FORMATS_LABEL, MAX_DOC_CHARS, type LoadedDocument } from "../engine/documents";
import type { RestoreOutcome } from "../engine/gateway";
import type { SanitizeResult, SessionSummary } from "../engine/vault";
import { useEngine } from "../engine-context";
import {
  Button,
  ConfirmDialog,
  CopyButton,
  Dialog,
  ErrorNote,
  PageHeader,
  Panel,
  PanelTitle,
  Segmented,
  Tag,
  VeiledText,
  cx,
  inputClass,
  relativeTime,
  useToast,
} from "../components/ui";

const SAMPLE =
  "Hi Sarah, please send John Carter the invoice for $2,500 at john@example.com. If he doesn't reply by Friday, call him on (415) 555-0132. His office is at 221 Market Street, San Francisco.";
const AGENT = "you";

interface PendingRestore {
  requestId: string;
  summary: string;
  text: string;
}

export function Privacy() {
  const engine = useEngine();
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [text, setText] = useState("");
  const [sensitivity, setSensitivity] = useState<Sensitivity>("medium");
  const [categories, setCategories] = useState<Category[]>(DEFAULT_CATEGORIES);
  const [result, setResult] = useState<SanitizeResult | null>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [doc, setDoc] = useState<LoadedDocument | null>(null);
  const [resultDoc, setResultDoc] = useState<LoadedDocument | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  function loadDocument(d: LoadedDocument) {
    setDoc(d);
    setDocError(null);
    setText(d.text);
    setResult(null);
    toast(`Read ${d.name} in your browser. Choose what to look for, then select Redact.`);
  }

  const refresh = useCallback(async () => {
    let list = await engine.vault.list();
    if (!list.length) {
      await engine.vault.createSession("My first session");
      list = await engine.vault.list();
    }
    setSessions(list);
    const saved = await engine.kv.get<string>("settings", "currentSession");
    setSessionId((current) => {
      const pick = [current, saved].find((id) => id && list.some((s) => s.id === id));
      return pick ?? list[0].id;
    });
  }, [engine]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (sessionId) void engine.kv.put("settings", "currentSession", sessionId);
  }, [engine, sessionId]);

  async function redact() {
    setBusy(true);
    setError(null);
    try {
      const r = await engine.sanitize(text, sessionId, categories, sensitivity);
      setResult(r);
      setSource(text);
      setResultDoc(doc);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function newSession() {
    const s = await engine.vault.createSession();
    setSessionId(s.id);
    setResult(null);
    await refresh();
    toast("New session started. Placeholders start again from 1.");
  }

  const highlighted = useMemo(() => {
    if (!result) return null;
    const nodes: ReactNode[] = [];
    let cursor = 0;
    result.redactions.forEach((r, i) => {
      nodes.push(<span key={`t${i}`}>{source.slice(cursor, r.start)}</span>);
      nodes.push(
        <mark key={`m${i}`} className="mark-original bg-transparent text-ink" title={`${r.category} → ${r.placeholder}`}>
          {source.slice(r.start, r.end)}
        </mark>,
      );
      cursor = r.end;
    });
    nodes.push(<span key="end">{source.slice(cursor)}</span>);
    return nodes;
  }, [result, source]);

  const current = sessions.find((s) => s.id === sessionId);

  return (
    <>
      <PageHeader
        title="Privacy protection"
        description="Redact personal and financial details before you paste text into an AI model or tool. The mapping back to the real values stays encrypted in this browser, and only you can restore it."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]">
        <label htmlFor="session" className="text-muted">
          Session
        </label>
        <select
          id="session"
          value={sessionId}
          onChange={(e) => {
            setSessionId(e.target.value);
            setResult(null);
          }}
          className="h-9 max-w-[260px] rounded-full bg-panel pr-8 pl-3.5 ring-1 ring-line focus:ring-2 focus:ring-veil focus:outline-none"
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label} ({s.count})
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={newSession}>
          New session
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setManageOpen(true)}>
          Manage sessions
        </Button>
        {current ? <span className="text-muted">{current.count} stored value{current.count === 1 ? "" : "s"}</span> : null}
      </div>

      <DropTarget className="mb-6 rounded-[24px]" onLoaded={loadDocument} onError={setDocError}>
      <Panel>
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {doc ? (
            <DocumentChip
              doc={doc}
              chars={text.length}
              onRemove={() => {
                setDoc(null);
                setText("");
                setResult(null);
              }}
            />
          ) : (
            <p className="text-[13px] text-muted">Paste text below, or upload a document. {FORMATS_LABEL}, up to 15 MB. Files are read in your browser and never uploaded anywhere.</p>
          )}
          <div className="shrink-0">
            <UploadButton label={doc ? "Upload another" : "Upload a document"} variant="secondary" onLoaded={loadDocument} onError={setDocError} />
          </div>
        </div>
        {docError ? (
          <p role="alert" className="mb-3 rounded-xl bg-deny-wash px-3 py-2 text-[13px] text-deny">
            {docError}
          </p>
        ) : null}
        <label htmlFor="input" className="sr-only">
          Text to redact
        </label>
        <textarea
          id="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={doc ? 10 : 5}
          maxLength={MAX_DOC_CHARS}
          placeholder="Paste text that contains names, emails, phone numbers, amounts…"
          className="w-full resize-y rounded-2xl bg-sunken p-4 text-[15px] leading-relaxed ring-1 ring-inset ring-line placeholder:text-muted/70 focus:bg-panel focus:ring-2 focus:ring-veil focus:outline-none"
        />
        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label="Sensitivity: fewer matches, balanced, or catch more"
              value={sensitivity}
              onChange={setSensitivity}
              options={[
                { value: "low", label: "Fewer" },
                { value: "medium", label: "Balanced" },
                { value: "high", label: "More" },
              ]}
            />
            <button type="button" onClick={() => { setDoc(null); setText(SAMPLE); }} className="text-[13px] text-veil-deep hover:underline">
              Fill with sample text
            </button>
          </div>
          <Button variant="primary" onClick={redact} busy={busy} disabled={!text.trim() || !sessionId}>
            Redact
          </Button>
        </div>
        <fieldset className="mt-4 border-t border-line pt-4">
          <legend className="sr-only">What to detect</legend>
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((c) => {
              const on = categories.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setCategories(on ? categories.filter((x) => x !== c.id) : [...categories, c.id])}
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
        <div className="mt-4">
          <ErrorNote error={error} />
        </div>
      </Panel>
      </DropTarget>

      {result ? (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel>
              <PanelTitle hint="Highlighted parts were detected. This text stays on your device.">Original</PanelTitle>
              <p className="max-h-[28rem] overflow-y-auto text-[15px] leading-[1.8] break-words whitespace-pre-wrap" data-testid="original-view">
                {highlighted}
              </p>
            </Panel>
            <Panel className="ring-veil-line">
              <PanelTitle hint={resultDoc ? "Safe to paste or share. Download it as a file, or copy it." : "Safe to paste into a model or tool."} action={<CopyButton value={result.sanitizedText} label="Copy redacted" />}>
                Redacted
              </PanelTitle>
              <div className="-mt-2 mb-3">
                <DownloadButtons text={result.sanitizedText} doc={resultDoc} suffix="redacted" />
              </div>
              <p className="max-h-[28rem] overflow-y-auto text-[15px] leading-[1.8] break-words whitespace-pre-wrap" data-testid="redacted-view">
                <VeiledText text={result.sanitizedText} animate />
              </p>
            </Panel>
          </div>
          <Panel className="mt-6">
            <PanelTitle hint={`${result.redactions.length} redacted, ${result.placeholders.length} distinct.`}>What was found</PanelTitle>
            {result.redactions.length === 0 ? (
              <p className="text-sm text-muted">Nothing matched. Try “More” sensitivity or turn on more categories.</p>
            ) : (
              <ul className="flex flex-wrap gap-x-6 gap-y-2">
                {CATEGORIES.filter((c) => result.categoryCounts[c.id]).map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-[13px]">
                    <span className="text-muted">{c.label}</span>
                    <span className="flex flex-wrap gap-1">
                      {result.placeholders
                        .filter((p) => p.category === c.id)
                        .map((p) => (
                          <span key={p.placeholder} className="veil">
                            {p.placeholder.slice(1, -1)}
                          </span>
                        ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      ) : null}

      <RestorePanel sessionId={sessionId} suggestion={result?.sanitizedText} suggestionDoc={resultDoc} />
      <SessionsDialog
        open={manageOpen}
        sessions={sessions}
        onClose={() => setManageOpen(false)}
        onChanged={async () => {
          setResult(null);
          await refresh();
        }}
      />
    </>
  );
}

function RestorePanel({ sessionId, suggestion, suggestionDoc }: { sessionId: string; suggestion?: string; suggestionDoc: LoadedDocument | null }) {
  const engine = useEngine();
  const toast = useToast();
  const [text, setText] = useState("");
  const [doc, setDoc] = useState<LoadedDocument | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null);
  const [show, setShow] = useState(true);
  const [busy, setBusy] = useState(false);

  async function request() {
    setBusy(true);
    setOutcome(null);
    try {
      const r = await engine.restore(AGENT, text, sessionId);
      if (r.status === "approval_required" && r.approvalRequestId) {
        const req = engine.approvals.get(r.approvalRequestId);
        setPending({ requestId: r.approvalRequestId, summary: req?.summary ?? "", text });
      } else {
        setOutcome(r);
        setShow(true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!pending) return;
    setBusy(true);
    try {
      const token = await engine.approvals.approve(pending.requestId);
      const r = await engine.restore(AGENT, pending.text, sessionId, token);
      setOutcome(r);
      setShow(true);
      if (r.status === "restored") toast(`Restored ${r.restored} value${r.restored === 1 ? "" : "s"}. The approval has been used up.`);
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  function deny() {
    if (pending) engine.approvals.deny(pending.requestId);
    setPending(null);
    setOutcome({ status: "denied", explanation: "You declined to reveal the values. Nothing was restored." });
  }

  return (
    <Panel className="mt-6" id="restore">
      <PanelTitle hint="Paste a reply that contains placeholders, such as a model’s answer. Only placeholders from the selected session can be restored.">
        Restore original values
      </PanelTitle>
      <label htmlFor="restore-input" className="sr-only">
        Text with placeholders
      </label>
      <textarea
        id="restore-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={doc ? 8 : 3}
        maxLength={MAX_DOC_CHARS}
        placeholder="e.g. Done — I emailed [PERSON_1] at [EMAIL_1] about [AMOUNT_1]."
        className={inputClass + " h-auto resize-y py-3 leading-relaxed"}
      />
      {docError ? (
        <p role="alert" className="mt-3 rounded-xl bg-deny-wash px-3 py-2 text-[13px] text-deny">
          {docError}
        </p>
      ) : null}
      {doc ? (
        <div className="mt-3">
          <DocumentChip doc={doc} chars={text.length} onRemove={() => { setDoc(null); setText(""); setOutcome(null); }} />
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {suggestion ? (
          <Button size="sm" variant="ghost" onClick={() => { setText(suggestion); setDoc(suggestionDoc); setOutcome(null); }}>
            Use the redacted text
          </Button>
        ) : null}
        <UploadButton
          label="Upload a file"
          onLoaded={(d) => {
            setDoc(d);
            setText(d.text);
            setDocError(null);
            setOutcome(null);
          }}
          onError={setDocError}
        />
        <Button size="sm" onClick={request} busy={busy} disabled={!text.trim() || !sessionId}>
          Restore values
        </Button>
      </div>

      {outcome ? (
        <div className="mt-5 rounded-2xl bg-sunken p-4" data-testid="restore-outcome">
          {outcome.status === "restored" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Tag tone="allow">
                  Restored {outcome.restored}
                  {outcome.unknown ? `, ${outcome.unknown} not from this session` : ""}
                </Tag>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setShow((v) => !v)} aria-pressed={show}>
                    {show ? "Hide values" : "Show values"}
                  </Button>
                  <CopyButton value={outcome.text ?? ""} />
                  <DownloadButtons text={outcome.text ?? ""} doc={doc} suffix="restored" />
                </div>
              </div>
              <p className="mt-3 max-h-[28rem] overflow-y-auto text-[15px] leading-[1.8] break-words whitespace-pre-wrap" data-testid="restored-text">
                {show ? outcome.text : <VeiledText text={text} />}
              </p>
            </>
          ) : (
            <>
              <Tag tone="deny">Not restored</Tag>
              <p className="mt-2 text-[13px] text-ink-soft">{outcome.explanation}</p>
            </>
          )}
        </div>
      ) : null}

      <Dialog
        open={!!pending}
        title="Reveal the original values?"
        onClose={deny}
        footer={
          <>
            <Button variant="ghost" onClick={deny} data-autofocus>
              Don’t reveal
            </Button>
            <Button variant="primary" busy={busy} onClick={approve}>
              Approve and reveal
            </Button>
          </>
        }
      >
        <p>{pending?.summary}.</p>
        <p className="mt-2 text-muted">
          Your “Restoring redacted values needs approval” policy asks for this every time. The approval works once, for exactly this text.
        </p>
      </Dialog>
    </Panel>
  );
}

function SessionsDialog({
  open,
  sessions,
  onClose,
  onChanged,
}: {
  open: boolean;
  sessions: SessionSummary[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const engine = useEngine();
  const toast = useToast();
  const [confirm, setConfirm] = useState<string | "all" | null>(null);

  async function remove() {
    if (confirm === "all") {
      await engine.vault.clearAll();
      toast("All sessions deleted from this browser.");
    } else if (confirm) {
      await engine.vault.remove(confirm);
      toast("Session deleted.");
    }
    setConfirm(null);
    await onChanged();
  }

  return (
    <>
      <Dialog open={open && !confirm} title="Your sessions" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
        <p className="text-muted">Each session keeps its own placeholders. Deleting one makes its text impossible to restore.</p>
        <ul className="mt-4 max-h-72 divide-y divide-line overflow-y-auto">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate font-medium text-ink">{s.label}</p>
                <p className="text-[12px] text-muted">
                  {s.count} value{s.count === 1 ? "" : "s"}, updated {relativeTime(s.updatedAt)}
                </p>
              </div>
              <Button size="sm" variant="danger" onClick={() => setConfirm(s.id)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
        {sessions.length > 1 ? (
          <Button size="sm" variant="danger" className="mt-3" onClick={() => setConfirm("all")}>
            Delete all sessions
          </Button>
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={!!confirm}
        title={confirm === "all" ? "Delete every session?" : "Delete this session?"}
        body="The stored values are erased from this browser. Text redacted in these sessions can no longer be restored."
        confirmLabel={confirm === "all" ? "Delete all" : "Delete session"}
        onConfirm={remove}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}
