import { Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { ToastProvider } from "./components/ui";
import { Activity } from "./pages/Activity";
import { Agents } from "./pages/Agents";
import { Integrations } from "./pages/Integrations";
import { Overview } from "./pages/Overview";
import { Policies } from "./pages/Policies";
import { PrivacyLab } from "./pages/PrivacyLab";
import { Settings } from "./pages/Settings";
import { SignIn } from "./pages/SignIn";
import { SessionProvider, useSession } from "./session";

function Shell() {
  const { signedIn } = useSession();
  if (!signedIn) return <SignIn />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/privacy-lab" element={<PrivacyLab />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/policies" element={<Policies />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export function App() {
  return (
    <SessionProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </SessionProvider>
  );
}
