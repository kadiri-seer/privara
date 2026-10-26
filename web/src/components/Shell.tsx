import { useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { useEngine } from "../engine-context";
import { cx } from "./ui";

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5">
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

const LINKS = [
  { to: "/privacy", label: "Privacy protection" },
  { to: "/actions", label: "Action protection" },
];

export function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const engine = useEngine();
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-white">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1160px] items-center justify-between gap-4 px-4 sm:px-8">
          <NavLink to="/" aria-label="Privara home">
            <Wordmark />
          </NavLink>
          <button
            type="button"
            className="rounded-full px-3 py-1.5 text-sm ring-1 ring-line md:hidden"
            aria-expanded={open}
            aria-controls="site-nav"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Close" : "Menu"}
          </button>
          <nav
            id="site-nav"
            aria-label="Main"
            className={cx(
              "absolute top-16 right-0 left-0 flex-col gap-1 border-b border-line bg-paper p-4 md:static md:flex md:flex-row md:items-center md:border-0 md:bg-transparent md:p-0",
              open ? "flex" : "hidden",
            )}
          >
            {LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cx("rounded-full px-3.5 py-2 text-[14px] transition-colors", isActive ? "bg-ink text-white" : "text-ink-soft hover:bg-sunken hover:text-ink")
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      {!engine.persistent ? (
        <p role="status" className="bg-hold-wash px-4 py-2 text-center text-[13px] text-hold">
          Your browser is blocking local storage, so sessions and policies will be lost when you close this tab.
        </p>
      ) : null}
      <main id="main" key={location.pathname} className="mx-auto w-full max-w-[1160px] flex-1 px-4 py-10 sm:px-8 md:py-14">
        {children}
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto max-w-[1160px] px-4 py-6 text-[13px] text-muted sm:px-8">
          <p>Privara runs entirely in your browser. Nothing you enter is sent anywhere.</p>
        </div>
      </footer>
    </div>
  );
}
