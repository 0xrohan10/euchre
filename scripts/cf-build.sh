#!/usr/bin/env bash
set -euo pipefail

# Cloudflare Workers Builds runs: build command, then deploy command.
# Migrations run here so DATABASE_URL stays a CF build secret (not GitHub).
# Skip migrate on non-production branch builds so previews never touch prod.

PRODUCTION_BRANCH="${CF_PRODUCTION_BRANCH:-main}"

bun run assets:verify

if [[ "${WORKERS_CI:-}" != "1" || "${WORKERS_CI_BRANCH:-}" == "${PRODUCTION_BRANCH}" ]]; then
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL is required for migrations" >&2
    exit 1
  fi
  echo "Applying database migrations (branch=${WORKERS_CI_BRANCH:-local})..."
  bun run db:migrate
else
  echo "Skipping migrations on non-production branch ${WORKERS_CI_BRANCH}"
  bun scripts/prepare-preview-wrangler.mjs
fi

bun run build
