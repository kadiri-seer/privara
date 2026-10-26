# Privara server image: REST API, MCP over HTTP and the dashboard on one port.
# Data (databases, vault key, sandbox) lives in /var/data — mount a persistent disk there.

# ---- dashboard build -------------------------------------------------------------------------
FROM node:22-bookworm-slim AS dashboard
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- server ----------------------------------------------------------------------------------
FROM python:3.12-slim-bookworm
RUN pip install --no-cache-dir uv==0.11.32

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app/backend
# Dependencies first (cached layer), pinned by uv.lock, including the spaCy model.
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --extra nlp --no-install-project
COPY backend/privara ./privara
RUN uv sync --frozen --no-dev --extra nlp

COPY --from=dashboard /app/frontend/dist /app/frontend/dist

ENV PATH="/app/backend/.venv/bin:$PATH" \
    PRIVARA_DEPLOYMENT=hosted \
    PRIVARA_DATA_DIR=/var/data \
    PRIVARA_FRONTEND_DIST=/app/frontend/dist \
    PRIVARA_HOST=0.0.0.0 \
    PORT=8787

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8787\")}/api/health', timeout=4)" || exit 1

# `init` is idempotent: it creates databases on first boot and seeds missing built-in policies.
CMD ["sh", "-c", "privara init && exec privara serve --host 0.0.0.0 --allow-remote"]
