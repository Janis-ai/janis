#!/usr/bin/env bash
# Pre-flight gate shared by deploy-gcp.sh and the pre-push git hook:
# typecheck every workspace, then run the api + web unit suites. Nothing
# untested should reach main or Cloud Run — the deploy's post-deploy probe
# only checks /health and /, which a broken feature passes just fine.
#
# SKIP_TESTS=1 bypasses it for genuine emergencies (hotfix with a known-red
# unrelated test). Say why in the commit message if you use it.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${SKIP_TESTS:-}" = "1" ]; then
  echo "preflight: SKIPPED (SKIP_TESTS=1)" >&2
  exit 0
fi

start=$(date +%s)
step() { echo "--- preflight: $1 ---"; }

step "typecheck"
npm run typecheck --silent
step "api tests"
npm test -w apps/api --silent
step "web tests"
npm test -w apps/web --silent

echo "--- preflight: OK in $(( $(date +%s) - start ))s ---"
