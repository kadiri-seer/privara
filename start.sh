#!/usr/bin/env bash
# Privara — one-command local startup.
#   ./start.sh            install deps (first run), build the dashboard, initialise data, serve on 127.0.0.1:8787
#   ./start.sh --rebuild  force a fresh dashboard build
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Privara needs '$1' on your PATH. $2" >&2; exit 1; }; }
need uv  "Install it from https://docs.astral.sh/uv/ (e.g. 'pipx install uv')."
need npm "Install Node.js 20 or newer from https://nodejs.org/."

echo "› Installing backend dependencies (Python 3.12+, pinned by backend/uv.lock)…"
uv --directory backend sync --frozen --extra nlp

if [[ ! -d frontend/node_modules ]]; then
  echo "› Installing dashboard dependencies (pinned by frontend/package-lock.json)…"
  (cd frontend && npm ci --no-audit --no-fund)
fi

if [[ "${1:-}" == "--rebuild" || ! -f frontend/dist/index.html || -n "$(find frontend/src -newer frontend/dist/index.html -print -quit)" ]]; then
  echo "› Building the dashboard…"
  (cd frontend && npm run build)
fi

echo "› Initialising local data (prints an admin key on first run only)…"
uv --directory backend run privara init

PORT="${PRIVARA_PORT:-8787}"
echo
echo "  Privara is starting at http://127.0.0.1:${PORT}"
echo "  API docs: http://127.0.0.1:${PORT}/api/docs   MCP (HTTP): http://127.0.0.1:${PORT}/mcp"
echo
exec uv --directory backend run privara serve
