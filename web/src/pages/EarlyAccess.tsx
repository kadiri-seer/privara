import { useRef, useState, type FormEvent } from "react";
import { TELEGRAM_URL, X_URL } from "../components/Shell";
import { Button, Field, PageHeader, Panel, Segmented, cx, inputClass } from "../components/ui";

export const CATEGORIES = ["Trading or finance agent", "Customer support agent", "Coding agent", "Personal assistant", "Research or data agent", "Sales or marketing agent", "Other"];
export const STAGES = ["Idea", "Prototype", "In production"] as const;
export const ACTIONS = ["Sends emails or messages", "Moves money or trades", "Reads or writes files", "Runs code", "Browses the web", "Handles customer data", "Calls third-party APIs"];

type Stage = (typeof STAGES)[number];
type Errors = Partial<Record<"product" | "website" | "description" | "category" | "stage" | "name" | "email" | "consent", string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function check(f: { product: string; website: string; description: string; category: string; name: string; email: string; consent: boolean }): Errors {
  const e: Errors = {};
  if (f.product.trim().length < 2) e.product = "Tell us the name of your agent or product.";
  if (f.website.trim() && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(f.website.trim())) e.website = "Use a full link starting with https://";
  if (f.description.trim().length < 20) e.description = "Describe what your agent does in at least a sentence.";
  if (!f.category) e.category = "Choose what kind of agent it is.";
  if (f.name.trim().length < 2) e.name = "Tell us your name.";
  if (!EMAIL_RE.test(f.email.trim())) e.email = "Enter an email address we can reach you at.";
  if (!f.consent) e.consent = "Please agree so we can contact you about early access.";
  return e;
}

export function EarlyAccess() {
  const startedAt = useRef(Date.now());
  const [product, setProduct] = useState("");
  const [website, setWebsite] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [stage, setStage] = useState<Stage>("Prototype");
  const [actions, setActions] = useState<string[]>([]);
  const [volume, setVolume] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [handle, setHandle] = useState("");
  const [consent, setConsent] = useState(false);
  const [trap, setTrap] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    const local = check({ product, website, description, category, name, email, consent });
    setErrors(local);
    if (Object.keys(local).length) {
      document.querySelector<HTMLElement>(`[data-field="${Object.keys(local)[0]}"], #field-${Object.keys(local)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          product, website, description, category, stage, actions, volume, name, email, handle, consent,
          company_fax: trap, started_at: startedAt.current,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        setSent(true);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        if (body?.error?.fields) setErrors(body.error.fields);
        setFailure(body?.error?.message ?? "Something went wrong. Please try again.");
      }
    } catch {
      setFailure("You seem to be offline. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="mx-auto max-w-xl py-10 text-center">
        <h1 className="text-[36px] leading-tight font-semibold tracking-[-0.03em]">Application received</h1>
        <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
          Thanks, {name.trim().split(/\s+/)[0]}. We’ll review {product.trim()} and reach out at {email.trim()} when a spot opens up.
        </p>
        <p className="mt-6 text-[15px] text-ink-soft">
          In the meantime, follow along on{" "}
          <a href={X_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-veil-deep hover:underline">X</a>{" "}
          or join the{" "}
          <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-veil-deep hover:underline">Telegram</a>.
        </p>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Early access"
        description="Building an agent or product that acts on its own? Apply to be among the first to put the Privara gateway between your agent and the tools it uses."
      />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <Panel>
          <form onSubmit={submit} noValidate className="flex flex-col gap-5">
            <h2 className="text-[15px] font-semibold">Your agent</h2>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Agent or product name" error={errors.product}>
                {(id, d) => <input id={id} data-field="product" aria-describedby={d} aria-invalid={!!errors.product} className={inputClass} value={product} onChange={(e) => setProduct(e.target.value)} maxLength={120} autoComplete="organization" />}
              </Field>
              <Field label="Website or link (optional)" error={errors.website}>
                {(id, d) => <input id={id} data-field="website" aria-describedby={d} aria-invalid={!!errors.website} className={inputClass} value={website} onChange={(e) => setWebsite(e.target.value)} maxLength={200} placeholder="https://" inputMode="url" />}
              </Field>
            </div>
            <Field label="What does it do on its own?" hint="The decisions it makes and the actions it takes without a person clicking." error={errors.description}>
              {(id, d) => (
                <textarea
                  id={id}
                  data-field="description"
                  aria-describedby={d}
                  aria-invalid={!!errors.description}
                  rows={4}
                  className={inputClass + " h-auto py-2.5 leading-relaxed"}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={1500}
                />
              )}
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="What kind of agent is it?" error={errors.category}>
                {(id, d) => (
                  <select id={id} data-field="category" aria-describedby={d} aria-invalid={!!errors.category} className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
                    <option value="">Choose one</option>
                    {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                  </select>
                )}
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-ink-soft">How far along is it?</span>
                <Segmented label="How far along is it?" value={stage} onChange={setStage} options={STAGES.map((s) => ({ value: s, label: s }))} />
              </div>
            </div>
            <fieldset>
              <legend className="text-[13px] font-medium text-ink-soft">What can it do? Pick all that apply.</legend>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {ACTIONS.map((a) => {
                  const on = actions.includes(a);
                  return (
                    <button
                      key={a}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setActions(on ? actions.filter((x) => x !== a) : [...actions, a])}
                      className={cx("h-8 rounded-full px-3.5 text-[13px] font-medium ring-1 ring-inset transition-colors", on ? "bg-veil-wash text-veil-deep ring-veil-line" : "bg-panel text-muted ring-line hover:text-ink")}
                    >
                      {a}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <Field label="Scale (optional)" hint="Users, agents or actions per day — a rough number is fine.">
              {(id, d) => <input id={id} data-field="volume" aria-describedby={d} className={inputClass} value={volume} onChange={(e) => setVolume(e.target.value)} maxLength={120} />}
            </Field>

            <h2 className="mt-2 border-t border-line pt-5 text-[15px] font-semibold">You</h2>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Your name" error={errors.name}>
                {(id, d) => <input id={id} data-field="name" aria-describedby={d} aria-invalid={!!errors.name} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" />}
              </Field>
              <Field label="Email" error={errors.email}>
                {(id, d) => <input id={id} data-field="email" aria-describedby={d} aria-invalid={!!errors.email} type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} autoComplete="email" />}
              </Field>
            </div>
            <Field label="X or Telegram handle (optional)">
              {(id, d) => <input id={id} data-field="handle" aria-describedby={d} className={inputClass} value={handle} onChange={(e) => setHandle(e.target.value)} maxLength={80} placeholder="@" />}
            </Field>
            <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
              <label>
                Company fax
                <input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
              </label>
            </div>
            <div>
              <label className="flex items-start gap-3 text-[14px]">
                <input id="field-consent" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 size-4 accent-[var(--color-ink)]" aria-invalid={!!errors.consent} />
                <span>Privara may contact me about early access using the details above.</span>
              </label>
              {errors.consent ? <p className="mt-1 pl-7 text-[12px] text-deny">{errors.consent}</p> : null}
            </div>
            {failure ? <p role="alert" className="rounded-xl bg-deny-wash px-3.5 py-2.5 text-[13px] text-deny">{failure}</p> : null}
            <div>
              <Button type="submit" variant="primary" busy={busy}>Submit application</Button>
            </div>
          </form>
        </Panel>

        <aside className="flex flex-col gap-8 lg:sticky lg:top-24">
          <section>
            <h2 className="text-[15px] font-semibold">What early access gets you</h2>
            <ul className="mt-3 flex flex-col gap-2.5 text-[14px] text-ink-soft">
              <li>The Privara gateway running in front of your agent, over MCP or REST.</li>
              <li>A key per agent, so you can see and revoke each one separately.</li>
              <li>Approvals for risky actions, like payments or emails, before they happen.</li>
              <li>Stronger name detection than the in-browser tools.</li>
              <li>A direct line to the team while we shape the product.</li>
            </ul>
          </section>
          <section>
            <h2 className="text-[15px] font-semibold">What happens next</h2>
            <ol className="mt-3 flex flex-col gap-2.5 text-[14px] text-ink-soft">
              <li>1. We read every application.</li>
              <li>2. If it’s a fit, we email you to set up a short call.</li>
              <li>3. We help you connect your first agent.</li>
            </ol>
          </section>
          <p className="rounded-2xl bg-sunken p-4 text-[13px] leading-relaxed text-ink-soft">
            Your answers go to the Privara team only. This form is the one part of the site that sends anything; the privacy and action tools never do.
          </p>
        </aside>
      </div>
    </>
  );
}
