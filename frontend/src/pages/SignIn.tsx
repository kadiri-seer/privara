import { useState, type FormEvent } from "react";
import { Wordmark, ProtectionStatus } from "../components/Layout";
import { Button, ErrorNote, Field, inputClass } from "../components/ui";
import { useSession } from "../session";

export function SignIn() {
  const { signIn, hosted } = useSession();
  const [key, setKey] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(key);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <Wordmark />
        <h1 className="mt-10 text-[40px] leading-[1.05] font-semibold tracking-[-0.035em]">
          Your agents.
          <br />
          Your boundaries.
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-muted">
          {hosted ? (
            <>
              Sign in with the admin key set as <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[13px] text-ink">PRIVARA_ADMIN_API_KEY</code> on your server.
            </>
          ) : (
            <>
              Sign in with the admin key printed when you first ran <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[13px] text-ink">privara init</code>.
            </>
          )}{" "}
          The key stays in this browser tab only.
        </p>
        <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
          <Field label="Admin key">
            {(id) => (
              <input
                id={id}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="pv_admin_…"
                className={inputClass + " font-mono"}
                required
              />
            )}
          </Field>
          <ErrorNote error={error} />
          <Button type="submit" variant="primary" busy={busy} disabled={!key.trim()}>
            Sign in
          </Button>
        </form>
        <div className="mt-10">
          <ProtectionStatus />
        </div>
        <p className="mt-4 text-[12px] text-muted">
          {hosted ? (
            <>Lost the key? It is in your hosting provider’s environment settings for the Privara service.</>
          ) : (
            <>
              Lost the key? Run <code className="font-mono">privara admin-key</code> on this machine to issue a new one.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
