import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import type { Decision } from "../api";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; busy?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: "bg-ink text-white hover:bg-ink-soft disabled:bg-line-strong",
    accent: "bg-veil text-white hover:bg-veil-deep disabled:opacity-50",
    secondary: "bg-panel text-ink ring-1 ring-inset ring-line hover:ring-line-strong hover:bg-sunken disabled:opacity-50",
    ghost: "text-ink-soft hover:bg-sunken disabled:opacity-50",
    danger: "bg-panel text-deny ring-1 ring-inset ring-deny/30 hover:bg-deny-wash disabled:opacity-50",
  };
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors whitespace-nowrap",
        size === "sm" ? "h-8 px-3.5 text-[13px]" : "h-10 px-5 text-sm",
        styles[variant],
        className,
      )}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
    />
  );
}

export function Panel({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx("rounded-[var(--radius-panel)] bg-panel ring-1 ring-line shadow-[var(--shadow-panel)]", padded && "p-6", className)}>
      {children}
    </section>
  );
}

export function PanelTitle({ children, action, hint }: { children: ReactNode; action?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{children}</h2>
        {hint ? <p className="mt-0.5 text-[13px] text-muted">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div className="max-w-2xl">
        <h1 className="text-[34px] leading-[1.1] font-semibold tracking-[-0.03em] md:text-[40px]">{title}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">{description}</p>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

const decisionStyle: Record<string, string> = {
  allow: "bg-allow-wash text-allow",
  deny: "bg-deny-wash text-deny",
  approval_required: "bg-hold-wash text-hold",
};
const decisionLabel: Record<string, string> = {
  allow: "Allow",
  deny: "Deny",
  approval_required: "Needs approval",
};

export function DecisionBadge({ decision }: { decision: Decision | string }) {
  return (
    <span className={cx("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap", decisionStyle[decision] ?? "bg-sunken text-ink-soft")}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {decisionLabel[decision] ?? decision}
    </span>
  );
}

export const outcomeLabel: Record<string, string> = {
  executed: "Executed",
  failed: "Ran, then failed",
  blocked: "Not run",
  rejected: "Rejected",
  pending_approval: "Waiting for approval",
  approval_rejected: "Not run — token refused",
  decision_only: "Decision only",
  sanitized: "Sanitized",
  restored: "Values restored",
};

export function OutcomeText({ outcome }: { outcome: string }) {
  const ran = ["executed", "restored", "sanitized"].includes(outcome);
  return <span className={cx("text-[13px]", ran ? "text-ink" : "text-muted")}>{outcomeLabel[outcome] ?? outcome}</span>;
}

export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "veil" | "allow" | "deny" | "hold" }) {
  const tones = {
    neutral: "bg-sunken text-ink-soft",
    veil: "bg-veil-wash text-veil-deep",
    allow: "bg-allow-wash text-allow",
    deny: "bg-deny-wash text-deny",
    hold: "bg-hold-wash text-hold",
  };
  return <span className={cx("inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (id: string, describedBy?: string) => ReactNode;
}) {
  const id = useId();
  const hintId = hint || error ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink-soft">
        {label}
      </label>
      {children(id, hintId)}
      {error ? (
        <p id={hintId} className="text-[12px] text-deny">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-[12px] text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass =
  "h-10 w-full rounded-xl bg-panel px-3.5 text-sm ring-1 ring-inset ring-line placeholder:text-muted/70 hover:ring-line-strong focus:outline-none focus:ring-2 focus:ring-veil";

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx("relative h-6 w-10 shrink-0 rounded-full transition-colors", checked ? "bg-ink" : "bg-line-strong")}
    >
      <span className={cx("absolute top-0.5 left-0 size-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-full bg-sunken p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-8 rounded-full px-3.5 text-[13px] font-medium transition-colors",
            value === o.value ? "bg-panel text-ink shadow-sm ring-1 ring-line" : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-line px-6 py-10 text-center">
      <VeilMotif />
      <p className="mt-4 text-sm font-medium">{title}</p>
      {children ? <p className="mt-1 max-w-sm text-[13px] text-muted">{children}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** Small abstract illustration: lines of text partly covered by veils. */
export function VeilMotif({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 64" className={cx("h-14 w-auto", className)} aria-hidden>
      <rect x="4" y="8" width="44" height="8" rx="4" fill="#E4E4E7" />
      <rect x="52" y="6" width="40" height="12" rx="6" fill="#EFEDFC" stroke="#D6D1F8" />
      <rect x="96" y="8" width="20" height="8" rx="4" fill="#E4E4E7" />
      <rect x="4" y="28" width="22" height="8" rx="4" fill="#E4E4E7" />
      <rect x="30" y="26" width="32" height="12" rx="6" fill="#EFEDFC" stroke="#D6D1F8" />
      <rect x="66" y="28" width="50" height="8" rx="4" fill="#E4E4E7" />
      <rect x="4" y="48" width="64" height="8" rx="4" fill="#E4E4E7" />
      <rect x="72" y="46" width="28" height="12" rx="6" fill="#EFEDFC" stroke="#D6D1F8" />
    </svg>
  );
}

/** Renders text with [CATEGORY_N] placeholders as veil chips. */
export function VeiledText({ text, animate = false }: { text: string; animate?: boolean }) {
  const parts = text.split(/(\[[A-Z_]+_\d+\])/g);
  return (
    <>
      {parts.map((part, i) =>
        /^\[[A-Z_]+_\d+\]$/.test(part) ? (
          <span key={i} className={cx("veil", animate && "veil-in")} style={animate ? { animationDelay: `${Math.min(i, 12) * 40}ms` } : undefined}>
            {part.slice(1, -1)}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="overflow-hidden rounded-2xl bg-ink text-zinc-100">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-1.5">
        <span className="text-xs text-zinc-400">{label}</span>
        <CopyButtonDark value={code} />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function CopyButtonDark({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded-full px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/10 hover:text-white"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function Dialog({
  open,
  title,
  children,
  onClose,
  footer,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusable = node?.querySelector<HTMLElement>("[data-autofocus], button, input, select, textarea");
    focusable?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && node) {
        const items = Array.from(node.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]")).filter((el) => !el.hasAttribute("disabled"));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 p-4 backdrop-blur-[2px] sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-md rounded-3xl bg-panel p-6 shadow-[var(--shadow-float)] ring-1 ring-line">
        <h2 id={titleId} className="text-lg font-semibold tracking-[-0.015em]">
          {title}
        </h2>
        <div className="mt-2 text-sm text-ink-soft">{children}</div>
        {footer ? <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  busy,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-autofocus>
            Cancel
          </Button>
          <Button variant="danger" busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}

/** Shows a newly generated secret exactly once. */
export function SecretDialog({ secret, title, onClose }: { secret: string | null; title: string; onClose: () => void }) {
  return (
    <Dialog
      open={!!secret}
      title={title}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          I’ve stored it
        </Button>
      }
    >
      <p>Copy this key now. Privara keeps only a hash, so it can’t show the key again.</p>
      <div className="mt-4 flex items-center gap-2 rounded-2xl bg-sunken p-3 ring-1 ring-line">
        <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-ink" data-testid="secret-value">
          {secret}
        </code>
        {secret ? <CopyButton value={secret} /> : null}
      </div>
    </Dialog>
  );
}

// ---- toasts ---------------------------------------------------------------------------------
type Toast = { id: number; message: string; tone: "ok" | "error" };
const ToastContext = createContext<(message: string, tone?: Toast["tone"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cx(
              "pointer-events-auto rounded-2xl px-4 py-3 text-sm shadow-[var(--shadow-float)] ring-1",
              t.tone === "ok" ? "bg-ink text-white ring-ink" : "bg-panel text-deny ring-deny/30",
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className="rounded-xl bg-deny-wash px-3.5 py-2.5 text-[13px] text-deny">
      {message}
    </p>
  );
}

export function formatTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function relativeTime(iso: string | null | undefined) {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

export function actionLabel(action: string) {
  const map: Record<string, string> = {
    "file.read": "Read file",
    "file.write": "Write file",
    "text.transform": "Transform text",
    "privacy.sanitize": "Sanitize text",
    "privacy.restore": "Restore values",
    "tool.unregistered": "Unregistered tool",
    "approval.approve": "Approval granted",
    "approval.deny": "Approval denied",
  };
  return map[action] ?? action;
}
