#!/usr/bin/env bash
# Runs on the EC2 host inside the cloned repository (typically ./deploy/ec2-deploy.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

BRANCH="${DEPLOY_BRANCH:-main}"
REMOTE="${DEPLOY_REMOTE:-origin}"

git fetch "$REMOTE"

current_branch="$(git rev-parse --abbrev-ref HEAD)"

if [[ "$current_branch" != "$BRANCH" ]]; then
  git checkout "$BRANCH"
fi

git pull --ff-only "$REMOTE" "$BRANCH"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required on the EC2 instance" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required (API runs with bun)." >&2
  exit 1
fi

npm ci

export NODE_ENV="${NODE_ENV:-production}"

npm run build

if command -v pm2 >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env ||
    pm2 start ecosystem.config.cjs --update-env
else
  echo "Install PM2 globally: npm install -g pm2, then rerun this script." >&2
  exit 1
fi
