import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import {
  Button,
  ConfirmDialog,
  ErrorNote,
  Field,
  PageHeader,
  Panel,
  PanelTitle,
  SecretDialog,
  Segmented,
  Tag,
  cx,
  formatTime,
  inputClass,
  useToast,
} from "../components/ui";
import { useSession } from "../session";

interface FileInfo {
  path: string;
  exists: boolean;
  bytes?: number;
  mode?: string;
}
interface SettingsData {
  settings: {
    default_categories: string[];
    detection_level: "low" | "medium" | "high";
    default_decision: "deny" | "approval_required";
    audit_retention_days: number;
    approval_ttl_seconds: number;
  };
  categories: { id: string; label: string }[];
  storage: {
    data_dir: string;
    sandbox_dir: string;
    main_db: FileInfo;
    vault_db: FileInfo;
    vault_key: FileInfo;
    counts: Record<string, number>;
    encryption: { vault_values: string; main_db: string; caveat: string };
    permissions_enforced: boolean;
  };
  limits: Record<string, number>;
}
interface Credential {
  id: string;
  label: string;
  source: string;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

type Danger = "sessions" | "purge" | "audit" | "demo" | "rotate" | null;

export function Settings() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [danger, setDanger] = useState<Danger>(null);
  const [resetPolicies, setResetPolicies] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { replaceKey } = useSession();

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.get<SettingsData>("/api/admin/settings"), api.get<{ items: Credential[] }>("/api/admin/credentials")]);
      setData(s);
      setCreds(c.items);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(change: Partial<SettingsData["settings"]>, message: string) {
    try {
      const r = await api.patch<{ settings: SettingsData["settings"] }>("/api/admin/settings", change);
      setData((d) => (d ? { ...d, settings: r.settings } : d));
      toast(message);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save.", "error");
    }
  }

  async function runDanger() {
    setBusy(true);
    try {
      if (danger === "sessions") {
        const r = await api.post<{ cleared_mappings: number }>("/api/admin/sessions/clear", { confirm: true });
        toast(`Cleared all sessions (${r.cleared_mappings} stored mappings deleted).`);
      } else if (danger === "purge") {
        const r = await api.post<{ removed: number }>("/api/admin/audit/purge", { confirm: true });
        toast(`Removed ${r.removed} events older than the retention period.`);
      } else if (danger === "audit") {
        const r = await api.post<{ removed: number }>("/api/admin/audit/clear", { confirm: true });
        toast(`Deleted ${r.removed} events.`);
      } else if (danger === "demo") {
        const r = await api.post<{ removed_events: number; policies_reset: boolean }>("/api/admin/demo/reset", { confirm: true, reset_policies: resetPolicies });
        toast(`Demo data removed (${r.removed_events} events).${r.policies_reset ? " Policies restored to built-in defaults." : ""}`);
      } else if (danger === "rotate") {
        const r = await api.post<{ api_key: string }>("/api/admin/credentials/rotate", { confirm: true });
        replaceKey(r.api_key);
        setSecret(r.api_key);
      }
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Action failed.", "error");
    } finally {
      setBusy(false);
      setDanger(null);
    }
  }

  if (!data) return <><PageHeader title="Settings" description="Detection defaults, enforcement defaults, storage and credentials." /><ErrorNote error={error} /></>;
  const s = data.settings;
  const st = data.storage;

  return (
    <>
      <PageHeader title="Settings" description="Detection defaults, enforcement defaults, storage and credentials. Changes apply to the next request." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <PanelTitle hint="Used when an agent doesn’t pass its own sensitivity settings.">Default redaction</PanelTitle>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Default redaction categories">
            {data.categories.map((c) => {
              const on = s.default_categories.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    save(
                      { default_categories: on ? s.default_categories.filter((x) => x !== c.id) : [...s.default_categories, c.id] },
                      `${c.label} ${on ? "will no longer be" : "will be"} redacted by default.`,
                    )
                  }
                  className={cx(
                    "h-8 rounded-full px-3.5 text-[13px] font-medium ring-1 ring-inset",
                    on ? "bg-veil-wash text-veil-deep ring-veil-line" : "bg-panel text-muted ring-line hover:text-ink",
                  )}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          <div className="mt-5">
            <p className="mb-2 text-[13px] font-medium text-ink-soft">Sensitivity</p>
            <Segmented
              label="Default sensitivity"
              value={s.detection_level}
              onChange={(v) => save({ detection_level: v }, "Default sensitivity saved.")}
              options={[
                { value: "low", label: "Fewer matches" },
                { value: "medium", label: "Balanced" },
                { value: "high", label: "Catch more" },
              ]}
            />
          </div>
        </Panel>

        <Panel>
          <PanelTitle hint="What happens to a request that no enabled policy matches. Unregistered tools are always denied.">Default decision</PanelTitle>
          <Segmented
            label="Default decision"
            value={s.default_decision}
            onChange={(v) => save({ default_decision: v }, v === "deny" ? "Unmatched requests will be denied." : "Unmatched requests will need approval.")}
            options={[
              { value: "deny", label: "Deny (recommended)" },
              { value: "approval_required", label: "Require approval" },
            ]}
          />
          <div className="mt-5 grid grid-cols-2 gap-4">
            <NumberSetting
              label="Approval token lifetime"
              suffix="seconds"
              value={s.approval_ttl_seconds}
              min={10}
              max={86400}
              onSave={(v) => save({ approval_ttl_seconds: v }, "Approval token lifetime saved.")}
            />
            <NumberSetting
              label="Keep audit events for"
              suffix="days (0 = forever)"
              value={s.audit_retention_days}
              min={0}
              max={3650}
              onSave={(v) => save({ audit_retention_days: v }, "Audit retention saved.")}
            />
          </div>
          <Button size="sm" className="mt-4" onClick={() => setDanger("purge")}>
            Purge expired events now
          </Button>
        </Panel>

        <Panel>
          <PanelTitle hint="Everything lives on this machine.">Local storage</PanelTitle>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
            {[
              ["Data folder", st.data_dir],
              ["Sandbox folder", st.sandbox_dir],
            ].map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="font-mono text-[12px] break-all">{v}</dd>
              </div>
            ))}
            {(
              [
                ["Main database", st.main_db],
                ["Vault database", st.vault_db],
                ["Vault key", st.vault_key],
              ] as [string, FileInfo][]
            ).map(([k, f]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd>
                  {f.exists ? `${((f.bytes ?? 0) / 1024).toFixed(1)} KB, mode ${f.mode}` : "missing"}
                </dd>
              </div>
            ))}
            <dt className="text-muted">Records</dt>
            <dd className="tabular">
              {st.counts.audit_events} events, {st.counts.redaction_sessions} sessions, {st.counts.vault_mappings} stored mappings
            </dd>
          </dl>
          <div className="mt-4 rounded-2xl bg-sunken p-4 text-[12.5px] leading-relaxed">
            <p><span className="font-medium">Vault:</span> {st.encryption.vault_values}</p>
            <p className="mt-1"><span className="font-medium">Main database:</span> {st.encryption.main_db}</p>
            <p className="mt-1 text-muted">{st.encryption.caveat}</p>
            {!st.permissions_enforced ? <p className="mt-1 text-hold">Owner-only file permissions are not enforced on this operating system.</p> : null}
          </div>
          <Button size="sm" variant="danger" className="mt-4" onClick={() => setDanger("sessions")}>
            Clear all redaction sessions
          </Button>
        </Panel>

        <Panel>
          <PanelTitle hint="Admin keys sign you in to this dashboard and the operator API. Only hashes are stored.">API credentials</PanelTitle>
          <ul className="divide-y divide-line text-[13px]">
            {creds.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
                <div>
                  <p className="font-medium">{c.label}</p>
                  <p className="text-[12px] text-muted">
                    {c.source === "environment" ? "From PRIVARA_ADMIN_API_KEY" : `Created ${formatTime(c.created_at)}, last used ${formatTime(c.last_used_at)}`}
                  </p>
                </div>
                {c.revoked_at ? <Tag tone="deny">Revoked</Tag> : <Tag tone="allow">Active</Tag>}
              </li>
            ))}
          </ul>
          <Button size="sm" className="mt-4" onClick={() => setDanger("rotate")}>
            Rotate admin key
          </Button>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelTitle hint="Destructive. Each action asks for confirmation first.">Data resets</PanelTitle>
          <div className="flex flex-col gap-4 md:flex-row md:items-center">
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={resetPolicies} onChange={(e) => setResetPolicies(e.target.checked)} className="size-4 accent-[var(--color-ink)]" />
              Also restore built-in policies and delete policies I created
            </label>
            <div className="flex flex-wrap gap-2 md:ml-auto">
              <Button size="sm" variant="danger" onClick={() => setDanger("demo")}>
                Reset demo data
              </Button>
              <Button size="sm" variant="danger" onClick={() => setDanger("audit")}>
                Delete entire audit log
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      <ConfirmDialog
        open={danger !== null}
        busy={busy}
        title={
          {
            sessions: "Clear every redaction session?",
            purge: "Purge expired audit events?",
            audit: "Delete the entire audit log?",
            demo: "Reset demo data?",
            rotate: "Rotate the admin key?",
          }[danger ?? "sessions"]
        }
        body={
          {
            sessions: "All stored placeholder mappings are deleted. Nothing sanitized so far can be restored afterwards.",
            purge: `Events older than ${s.audit_retention_days} days are permanently deleted.`,
            audit: "Every recorded decision is permanently deleted. This cannot be undone.",
            demo: resetPolicies
              ? "Demo events, approvals and sessions are deleted, and all policies are restored to the built-in set. Policies you created are deleted."
              : "Demo events, approvals and sessions are deleted. Your policies are kept.",
            rotate: "A new admin key is issued and shown once. Every other stored admin key stops working, including on other devices.",
          }[danger ?? "sessions"]
        }
        confirmLabel={{ sessions: "Clear sessions", purge: "Purge events", audit: "Delete audit log", demo: "Reset demo data", rotate: "Rotate key" }[danger ?? "sessions"]}
        onConfirm={runDanger}
        onClose={() => setDanger(null)}
      />
      <SecretDialog secret={secret} title="New admin key" onClose={() => setSecret(null)} />
    </>
  );
}

function NumberSetting({ label, suffix, value, min, max, onSave }: { label: string; suffix: string; value: number; min: number; max: number; onSave: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const n = Number(draft);
  const valid = Number.isInteger(n) && n >= min && n <= max;
  return (
    <Field label={label} hint={valid ? suffix : `Enter a whole number from ${min} to ${max}.`}>
      {(id, d) => (
        <div className="flex gap-2">
          <input id={id} aria-describedby={d} aria-invalid={!valid} type="number" min={min} max={max} value={draft} onChange={(e) => setDraft(e.target.value)} className={inputClass + " tabular"} />
          <Button size="sm" className="h-10" disabled={!valid || n === value} onClick={() => onSave(n)}>
            Save
          </Button>
        </div>
      )}
    </Field>
  );
}
