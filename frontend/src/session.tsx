import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getAdminKey, request, setAdminKey, setUnauthorizedHandler, type Health } from "./api";

interface SessionValue {
  signedIn: boolean;
  signIn: (key: string) => Promise<void>;
  signOut: () => void;
  replaceKey: (key: string) => void;
  health: Health | null;
  healthError: boolean;
  refreshHealth: () => Promise<void>;
  hosted: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(() => !!getAdminKey());
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);

  const signOut = useCallback(() => {
    setAdminKey(null);
    setSignedIn(false);
  }, []);

  useEffect(() => setUnauthorizedHandler(signOut), [signOut]);

  const signIn = useCallback(async (key: string) => {
    await request("GET", "/api/admin/session", undefined, key.trim());
    setAdminKey(key.trim());
    setSignedIn(true);
  }, []);

  const replaceKey = useCallback((key: string) => setAdminKey(key), []);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.get<Health>("/api/health"));
      setHealthError(false);
    } catch {
      setHealthError(true);
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    const timer = setInterval(() => void refreshHealth(), 15000);
    return () => clearInterval(timer);
  }, [refreshHealth]);

  return (
    <SessionContext.Provider value={{ signedIn, signIn, signOut, replaceKey, health, healthError, refreshHealth, hosted: health?.deployment === "hosted" }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}
