import { Navigate, Route, Routes } from "react-router";
import { Shell } from "./components/Shell";
import { ToastProvider } from "./components/ui";
import { EngineProvider } from "./engine-context";
import type { KV } from "./engine/storage";
import { Actions } from "./pages/Actions";
import { Home } from "./pages/Home";
import { Privacy } from "./pages/Privacy";

export function App({ kv }: { kv?: KV }) {
  return (
    <EngineProvider kv={kv}>
      <ToastProvider>
        <Shell>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/actions" element={<Actions />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </ToastProvider>
    </EngineProvider>
  );
}
