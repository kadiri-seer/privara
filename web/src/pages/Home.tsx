import { useEffect, useState } from "react";
import { Link } from "react-router";
import { CopyButton, DecisionBadge, VeiledText } from "../components/ui";

const BEFORE = "Send John Carter the invoice for $2,500 at john@example.com.";
const AFTER = "Send [PERSON_1] the invoice for [AMOUNT_1] at [EMAIL_1].";
export const TOKEN_CA = "0xdabdaf401ecb5123506ab940c9728d57e96556e3";

export function Home() {
  const [veiled, setVeiled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVeiled(true), 900);
    return () => clearTimeout(t);
  }, []);

  return (
    <>
      <section className="pb-16 md:pb-24">
        <TokenBanner />
        <h1 className="max-w-3xl text-[44px] leading-[1.02] font-semibold tracking-[-0.04em] sm:text-[64px]">
          Your agents.
          <br />
          Your boundaries.
        </h1>
        <p className="mt-6 max-w-2xl text-[17px] leading-relaxed text-ink-soft">
          Privara keeps personal details out of what you send to AI models, and puts your rules in front of what AI agents
          are allowed to do. It runs in your browser: nothing you type here leaves your device.
        </p>
        <div className="mt-10 rounded-[28px] bg-panel p-6 ring-1 ring-line shadow-[var(--shadow-panel)] sm:p-8">
          <p className="text-[19px] leading-[1.8] sm:text-[22px]" aria-live="polite">
            {veiled ? <VeiledText text={AFTER} animate /> : BEFORE}
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link to="/privacy" className="inline-flex h-11 items-center rounded-full bg-ink px-6 text-[15px] font-medium text-white hover:bg-ink-soft">
              Redact your text
            </Link>
            <Link to="/actions" className="inline-flex h-11 items-center rounded-full bg-panel px-6 text-[15px] font-medium ring-1 ring-line hover:bg-sunken">
              Check an agent action
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-12 border-t border-line py-16 md:grid-cols-2 md:gap-16">
        <div>
          <h2 className="text-[28px] font-semibold tracking-[-0.025em]">Privacy protection</h2>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
            Detect and redact sensitive information before it reaches external models or tools. Privara keeps the
            reversible mapping on your device and restores original values only when you explicitly authorise it.
          </p>
          <ul className="mt-6 flex flex-col gap-3 text-[14px]">
            <li className="flex gap-3"><Dot />Names, emails, phone numbers, money amounts, cards, bank accounts, ID numbers, places and links.</li>
            <li className="flex gap-3"><Dot />The same value always gets the same placeholder within a session, so replies still make sense.</li>
            <li className="flex gap-3"><Dot />Paste a model’s reply back in and restore the real values, after you approve it.</li>
          </ul>
          <Link to="/privacy" className="mt-6 inline-block text-[14px] font-medium text-veil-deep hover:underline">
            Open privacy protection
          </Link>
        </div>
        <div>
          <h2 className="text-[28px] font-semibold tracking-[-0.025em]">Action protection</h2>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
            Intercept tool calls, evaluate them against policies you configure, and allow, deny or require approval before
            anything runs.
          </p>
          <ul className="mt-6 flex flex-col gap-3 text-[14px]">
            <li className="flex items-center gap-3"><DecisionBadge decision="allow" /> Reading notes in the sandbox</li>
            <li className="flex items-center gap-3"><DecisionBadge decision="approval_required" /> Writing a file to the outbox</li>
            <li className="flex items-center gap-3"><DecisionBadge decision="deny" /> Reading <code className="font-mono text-[13px]">../</code> outside the sandbox</li>
          </ul>
          <p className="mt-4 text-[14px] text-ink-soft">Approvals are single-use, expire after five minutes and only work for the exact call you approved.</p>
          <Link to="/actions" className="mt-6 inline-block text-[14px] font-medium text-veil-deep hover:underline">
            Open action protection
          </Link>
        </div>
      </section>

      <section className="border-t border-line py-16">
        <h2 className="text-[28px] font-semibold tracking-[-0.025em]">Private by design</h2>
        <dl className="mt-8 grid gap-8 md:grid-cols-3">
          <div>
            <dt className="text-[15px] font-medium">No server sees your text</dt>
            <dd className="mt-2 text-[14px] leading-relaxed text-muted">Detection, redaction and policy checks run in this page. The tools never send anything over the network.</dd>
          </div>
          <div>
            <dt className="text-[15px] font-medium">Mappings are encrypted on your device</dt>
            <dd className="mt-2 text-[14px] leading-relaxed text-muted">Original values are sealed with an AES key your browser generates and refuses to export, even to this page.</dd>
          </div>
          <div>
            <dt className="text-[15px] font-medium">History holds decisions, not content</dt>
            <dd className="mt-2 text-[14px] leading-relaxed text-muted">The activity list records what was asked and decided. File contents and original values are never in it.</dd>
          </div>
        </dl>
      </section>


      <section className="border-t border-line py-16">
        <div className="flex flex-col gap-6 rounded-[28px] bg-ink p-8 text-white sm:p-10 md:flex-row md:items-center md:justify-between">
          <div className="max-w-xl">
            <h2 className="text-[28px] font-semibold tracking-[-0.025em]">Building an agent that acts on its own?</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-zinc-300">
              Put Privara between your agent and its tools. We’re opening the gateway to a small group of teams first.
            </p>
          </div>
          <Link to="/early-access" className="inline-flex h-11 shrink-0 items-center self-start rounded-full bg-white px-6 text-[15px] font-medium text-ink hover:bg-zinc-200 md:self-auto">
            Apply for early access
          </Link>
        </div>
      </section>
    </>
  );
}

function TokenBanner() {
  return (
    <div
      aria-label="$PRIVARA token"
      className="mb-10 flex max-w-2xl flex-col gap-3 rounded-2xl bg-panel p-4 ring-1 ring-line shadow-[var(--shadow-panel)] sm:flex-row sm:items-center sm:gap-4 sm:rounded-full sm:py-2 sm:pr-2 sm:pl-5"
    >
      <p className="flex shrink-0 items-center gap-2 text-[14px] font-semibold">
        <span aria-hidden className="relative flex size-2">
          <span className="absolute inline-flex size-full motion-safe:animate-ping rounded-full bg-veil opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-veil" />
        </span>
        $PRIVARA is live
      </p>
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-sunken sm:rounded-full py-1 pr-1 pl-3">
        <span className="shrink-0 text-[12px] font-medium text-muted">CA</span>
        <code data-testid="token-ca" className="min-w-0 flex-1 font-mono break-all text-[12.5px] text-ink" title={TOKEN_CA}>
          {TOKEN_CA}
        </code>
        <CopyButton value={TOKEN_CA} />
      </div>
    </div>
  );
}

function Dot() {
  return <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-veil" />;
}
