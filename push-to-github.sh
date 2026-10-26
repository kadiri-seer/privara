#!/usr/bin/env bash
# Publish this folder to your GitHub repository as ONE commit and ONE push.
#
#   ./push-to-github.sh https://github.com/<you>/<repo>.git [branch]
#
# It clones your repo into a temporary folder, replaces its files with this project's files
# (keeping your git history), commits once and pushes once. Nothing is force-pushed.
# Vercel (and Render, once the Blueprint exists) redeploy from that push.
# On Windows, run it from Git Bash.
set -euo pipefail

REPO_URL="${1:?Usage: ./push-to-github.sh https://github.com/<you>/<repo>.git [branch]}"
BRANCH="${2:-main}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v git >/dev/null || { echo "git is not installed." >&2; exit 1; }

echo "› Cloning $REPO_URL ($BRANCH)…"
if ! git clone --quiet --branch "$BRANCH" "$REPO_URL" "$WORK/repo" 2>/dev/null; then
  echo "  Branch '$BRANCH' not found; starting it fresh."
  git clone --quiet "$REPO_URL" "$WORK/repo"
  git -C "$WORK/repo" checkout --quiet --orphan "$BRANCH"
fi

echo "› Replacing repository files with this project…"
# Remove tracked files (keeps .git), then copy the project without local-only artefacts.
git -C "$WORK/repo" rm -r -q --ignore-unmatch . >/dev/null
tar -C "$SRC" \
  --exclude=./.git --exclude=./data --exclude=./.env \
  --exclude=./backend/.venv --exclude=./frontend/node_modules --exclude=./frontend/dist \
  --exclude='__pycache__' --exclude='.pytest_cache' --exclude='*.tsbuildinfo' \
  -cf - . | tar -C "$WORK/repo" -xf -

cd "$WORK/repo"
git add -A
if git diff --cached --quiet; then
  echo "Nothing changed — your repository already matches this project."
  exit 0
fi
git -c user.name="$(git config user.name || echo Privara)" -c user.email="$(git config user.email || echo privara@localhost)" \
  commit --quiet -m "Privara: privacy and action firewall for AI agents (dashboard on Vercel, server on Render)"
echo "› Pushing one commit to $BRANCH…"
git push --quiet origin "HEAD:$BRANCH"
echo "Done. Vercel will redeploy from this push."
