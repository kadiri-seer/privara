# Putting the Privara dashboard online

Two pieces, two hosts:

```
browser / agents ──▶ Vercel  (privara-32np.vercel.app)
                       ├─ serves the dashboard (frontend/dist)
                       └─ forwards /api/* and /mcp ──▶ Render  (privara-api.onrender.com)
                                                         └─ Python server + persistent disk (/var/data)
```

Vercel can't run the backend: it needs a process that stays up and a disk that survives restarts
(databases, encrypted vault, sandbox). Render runs it from the `Dockerfile` in this repo.

## 1. Deploy the backend on Render

1. Push this project to your GitHub repository in one go:

   ```bash
   ./push-to-github.sh https://github.com/<you>/<repo>.git
   ```

   It commits everything on top of your existing history as a single commit and pushes once
   (on Windows, run it from Git Bash). Vercel redeploys from that push.
2. In Render: **New → Blueprint**, choose the repository. Render reads `render.yaml` and creates the
   `privara-api` web service with a 1 GB disk at `/var/data`, in Frankfurt.
3. Confirm. The first build takes a few minutes (it installs spaCy and its English model).
4. When it's live, open the service's **Environment** tab and copy `PRIVARA_ADMIN_API_KEY`. That is
   your dashboard sign-in key. Render generated it; it is never printed in logs.
5. Note the service URL at the top, e.g. `https://privara-api.onrender.com`. If Render added a suffix
   (because the name was taken), you'll need it in step 2.

**Cost.** `render.yaml` uses Render's 512 MB paid instance plus a 1 GB disk (about $7.25 a month at
the time of writing). Privara uses about 180 MB of RAM at idle, so this size is enough.

Render's free instance can't attach a disk, sleeps after 15 idle minutes, and erases its files every
time it sleeps or redeploys. To run on it anyway, change `plan: starter` to `plan: free` and delete the
`disk:` block. Expect registered agents, policies and the audit log to disappear regularly; the admin key
survives because it lives in an environment variable.

## 2. Point Vercel at it

1. If your Render URL is not exactly `https://privara-api.onrender.com`, edit the two `destination`
   values in `vercel.json` to match.
2. If your Vercel domain is not `privara-32np.vercel.app` (or you add a custom domain), list every
   domain in `PRIVARA_ALLOWED_HOSTS` on Render, comma-separated, then redeploy the Render service.
3. Push to `main`. Vercel builds `frontend/` (settings come from `vercel.json`, so the project's
   Framework Preset and Root Directory should stay at their defaults: **Other** and the repo root).
4. Open `https://privara-32np.vercel.app` and sign in with the key from step 1.4.

## 3. Connect agents

Register an agent under **Agent Access**, then use the HTTP settings shown on **Integrations**:

- MCP: `https://privara-32np.vercel.app/mcp` with `Authorization: Bearer <agent key>`
- REST: `https://privara-32np.vercel.app/api/v1/…` with the same header

Agents can also use the Render URL directly. stdio MCP isn't available on a hosted server.

## What changes when Privara is hosted

`PRIVARA_DEPLOYMENT=hosted` (set by the Dockerfile) makes the server:

- bind to `0.0.0.0` on the platform's `PORT`, and trust the platform's `X-Forwarded-*` headers for
  HTTPS and the visitor's IP;
- accept only Host headers from `PRIVARA_ALLOWED_HOSTS` plus the hostname Render announces;
- refuse to start with a `PRIVARA_ADMIN_API_KEY` shorter than 32 characters;
- answer `429` after 20 failed sign-ins per minute from one address;
- describe itself correctly in the dashboard (text is processed on your server, not "on your machine").

Responses are marked `Cache-Control: no-store`, and `vercel.json` also turns off Vercel's rewrite
caching for `/api` and `/mcp`, so nothing sensitive is cached at the edge.

## Trade-offs to be aware of

- **The privacy boundary moves.** Locally, text never leaves your computer. Hosted, the Privacy Lab and
  agents send raw text over HTTPS to your server, and through Vercel's edge when you use the Vercel URL.
  Use the Render URL directly if you don't want Vercel in that path.
- **The sandbox is on the server.** `read_file` and `write_file` work on `/var/data/sandbox`, not on
  your laptop. Agents running on your own computer that need local file protection should use a local
  Privara instead.
- **Anyone who can reach the URL can try to sign in.** Keys are 256-bit random values and failed
  attempts are throttled, but keep the admin key private and rotate it if it leaks (Settings → Rotate
  admin key, or regenerate the variable in Render and redeploy).
- **Backups.** Check your Render disk's snapshot and backup options. Back up the whole `/var/data`
  directory together: the vault can't be read without `vault.key`.
