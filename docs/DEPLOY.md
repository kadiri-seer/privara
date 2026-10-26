# Deploying Privara

This repository contains two things:

| Folder | What it is | Where it runs |
| --- | --- | --- |
| `web/` | The public, open-access Privara site. Anyone can redact text, restore it with their own approval, write policies and check tool calls. Everything runs in the visitor's browser. | Vercel (static) |
| `backend/` + `frontend/` | The self-hosted gateway that agents connect to over MCP or REST, with its own operator dashboard. | Your computer, or your own server |

## The public site on Vercel

`vercel.json` at the repository root builds `web/` and serves `web/dist`. There is nothing to configure
in Vercel: keep the project's Framework Preset on **Other** and the Root Directory at the repository root.
Every push to `main` redeploys it.

What the site guarantees:

- **No backend for the tools.** Detection, redaction, restore, policies, approvals and the file sandbox
  all run in the page and never make network requests (enforced by tests). The Content-Security-Policy
  allows connections only to the site itself (`connect-src 'self'`), which the early access form needs.
- **Visitors' data stays with them.** Sessions, policies, sandbox files and decision history live in the
  visitor's IndexedDB. Original values are encrypted with an AES-GCM key generated as non-extractable,
  so even the page's own scripts can't read the key out.
- **Restoring needs the visitor's explicit approval**, enforced by the same policy, token and binding
  rules as the gateway.
- **Nothing about any operator is on it**: no sign-in, no admin key, no agents, no server logs.

Detection on the site uses pattern rules and word lists. The self-hosted gateway adds Presidio with a
spaCy NER model, which finds more names.

## Early access applications

The **Early access** page posts applications to `api/apply.js`, a Vercel serverless function that
validates them, filters obvious spam, and forwards each one. It stores nothing. Set at least one
destination in Vercel → Project → **Settings → Environment Variables**, then redeploy:

| Variable | What it does |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token of a bot created with [@BotFather](https://t.me/BotFather). |
| `TELEGRAM_CHAT_ID` | Where the bot posts: your chat, group or channel id (the bot must be a member). |
| `APPLY_WEBHOOK_URL` | Optional. Any webhook (Zapier, Make, Slack, Discord…) that should also receive each application as JSON. |

Until one is set, the form tells applicants that applications aren't open yet and points them to
Telegram and X.

## Publishing with one push

```bash
./push-to-github.sh https://github.com/<you>/<repo>.git
```

It commits the whole project on top of your existing history as a single commit and pushes once. On
Windows, run it from Git Bash.

## Self-hosting the gateway

Locally (recommended, so text never leaves your machine): `./start.sh`, then open
<http://127.0.0.1:8787>.

On a server: the `Dockerfile` runs the gateway in hosted mode with its data in `/var/data`, and
`render.yaml` deploys it on Render with a persistent disk (about $7.25 a month at the time of writing;
Render's free instance has no disk and erases its files whenever it sleeps). The gateway gets its own
URL, such as `https://privara-api.onrender.com`; it is separate from the public site.

Hosted mode (`PRIVARA_DEPLOYMENT=hosted`, set by the Dockerfile):

- binds to `0.0.0.0` on the platform's `PORT` and trusts its `X-Forwarded-*` headers;
- accepts only Host headers in `PRIVARA_ALLOWED_HOSTS` plus the hostname Render announces;
- requires `PRIVARA_ADMIN_API_KEY` to be at least 32 characters (`render.yaml` generates one — find it
  in the service's **Environment** tab);
- answers `429` after 20 failed sign-ins per minute from one address.

Trade-offs of hosting the gateway: agents' text crosses the network to your server, the sandbox lives on
the server rather than your computer, and the hosting provider can access the disk. Back up `/var/data`
as a whole — the vault can't be read without `vault.key`.
