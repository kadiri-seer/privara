import { useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { useSession } from "../session";
import { cx } from "./ui";

const NAV = [
  { to: "/", label: "Overview", icon: IconOverview },
  { to: "/privacy-lab", label: "Privacy Lab", icon: IconLab },
  { to: "/agents", label: "Agent Access", icon: IconAgents },
  { to: "/policies", label: "Policies", icon: IconPolicies },
  { to: "/activity", label: "Activity", icon: IconActivity },
  { to: "/integrations", label: "Integrations", icon: IconPlug },
  { to: "/settings", label: "Settings", icon: IconSettings },
];

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2.5", className)}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="9" fill="#18181B" />
        <rect x="7" y="9" width="18" height="4" rx="2" fill="#B9B0F5" />
        <rect x="7" y="15" width="12" height="4" rx="2" fill="#FAFAF8" />
        <rect x="7" y="21" width="15" height="4" rx="2" fill="#B9B0F5" opacity=".6" />
      </svg>
      <span className="text-[17px] font-semibold tracking-[-0.02em]">Privara</span>
    </span>
  );
}

export function ProtectionStatus() {
  const { health, healthError } = useSession();
  let tone = "bg-muted";
  let label = "Checking gateway…";
  let detail = "";
  if (healthError) {
    tone = "bg-deny";
    label = "Gateway unreachable";
    detail = "The local backend is not responding.";
  } else if (health) {
    const ok = health.status === "ok";
    tone = ok ? "bg-allow" : "bg-hold";
    label = ok ? "Protection active" : "Protection impaired";
    const failing = Object.entries(health.checks).filter(([, v]) => !v).map(([k]) => k);
    detail = ok
      ? health.detector.mode === "presidio+spacy"
        ? `NER model ${health.detector.model}`
        : "Pattern-only detection (no NER model)"
      : `Failing: ${failing.join(", ")}`;
  }
  return (
    <div className="rounded-2xl bg-panel p-3.5 ring-1 ring-line" data-testid="protection-status">
      <div className="flex items-center gap-2">
        <span className={cx("size-2 rounded-full", tone)} aria-hidden />
        <span className="text-[13px] font-medium">{label}</span>
      </div>
      {detail ? <p className="mt-1 pl-4 text-[12px] leading-snug text-muted">{detail}</p> : null}
      {health ? <p className="mt-1 pl-4 text-[12px] text-muted">Unmatched requests: {health.default_decision === "deny" ? "denied" : "need approval"}</p> : null}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { signOut } = useSession();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  return (
    <div className="min-h-screen md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-white">
        Skip to content
      </a>
      <div className="flex items-center justify-between border-b border-line bg-paper px-4 py-3 md:hidden">
        <Wordmark />
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="sidebar" className="rounded-full px-3 py-1.5 text-sm ring-1 ring-line">
          {open ? "Close" : "Menu"}
        </button>
      </div>
      <aside
        id="sidebar"
        className={cx(
          "flex-col gap-6 border-line bg-paper px-4 py-5 md:sticky md:top-0 md:flex md:h-screen md:w-[236px] md:shrink-0 md:border-r",
          open ? "flex border-b" : "hidden",
        )}
      >
        <div className="hidden px-2 md:block">
          <Wordmark />
          <p className="mt-2 text-[12px] text-muted">Your agents. Your boundaries.</p>
        </div>
        <nav aria-label="Main" className="flex flex-col gap-0.5">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cx(
                  "flex h-9 items-center gap-3 rounded-full px-3 text-[14px] transition-colors",
                  isActive ? "bg-ink text-white" : "text-ink-soft hover:bg-sunken hover:text-ink",
                )
              }
            >
              <Icon />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-3">
          <ProtectionStatus />
          <button type="button" onClick={signOut} className="self-start rounded-full px-3 py-1.5 text-[13px] text-muted hover:bg-sunken hover:text-ink">
            Sign out
          </button>
        </div>
      </aside>
      <main id="main" key={location.pathname} className="min-w-0 flex-1 px-4 py-8 sm:px-8 md:px-10 md:py-12">
        <div className="mx-auto max-w-[1120px]">{children}</div>
      </main>
    </div>
  );
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" className="size-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}
function IconOverview() {
  return <Svg><rect x="3" y="3" width="6" height="6" rx="2" /><rect x="11" y="3" width="6" height="6" rx="2" /><rect x="3" y="11" width="14" height="6" rx="2" /></Svg>;
}
function IconLab() {
  return <Svg><path d="M3 6h5M11 6h6M3 10h3M9 10h8M3 14h8M14 14h3" /></Svg>;
}
function IconAgents() {
  return <Svg><circle cx="10" cy="7" r="3" /><path d="M4 17c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5" /></Svg>;
}
function IconPolicies() {
  return <Svg><path d="M10 2.5 4 5v4.5c0 3.8 2.6 6.6 6 8 3.4-1.4 6-4.2 6-8V5l-6-2.5Z" /><path d="m7.5 10 1.8 1.8 3.4-3.6" /></Svg>;
}
function IconActivity() {
  return <Svg><path d="M3 10h3l2-5 4 10 2-5h3" /></Svg>;
}
function IconPlug() {
  return <Svg><path d="M7 3v4M13 3v4M5 7h10v3a5 5 0 0 1-10 0V7ZM10 15v2.5" /></Svg>;
}
function IconSettings() {
  return <Svg><circle cx="10" cy="10" r="2.5" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></Svg>;
}
