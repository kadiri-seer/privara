import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Privara } from "./engine/gateway";
import type { KV } from "./engine/storage";

const Ctx = createContext<Privara | null>(null);

/** Opens the in-browser engine once. Tests can pass their own storage. */
export function EngineProvider({ children, kv }: { children: ReactNode; kv?: KV }) {
  const [engine, setEngine] = useState<Privara | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    Privara.open(kv)
      .then((p) => alive && setEngine(p))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [kv]);
  if (failed) {
    return (
      <p role="alert" className="m-8 rounded-2xl bg-deny-wash p-4 text-sm text-deny">
        Privara couldn’t start in this browser. It needs a modern browser with Web Crypto support.
      </p>
    );
  }
  if (!engine) return <p className="m-8 text-sm text-muted">Starting Privara in your browser…</p>;
  return <Ctx.Provider value={engine}>{children}</Ctx.Provider>;
}

export function useEngine(): Privara {
  const engine = useContext(Ctx);
  if (!engine) throw new Error("useEngine outside EngineProvider");
  return engine;
}
