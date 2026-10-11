#!/usr/bin/env sh
# Generates the Spark prompt files the frontend serves from the backend catalog
# (backend/src/spark/catalog.ts, the source of truth).
# Usage: scripts/sync-spark-prompts.sh          write new-frontend/public/spark/prompts.<lang>.json
#        scripts/sync-spark-prompts.sh --check  exit 1 if the files differ from the catalog (used in CI)
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/backend"
exec bun scripts/exportSparkPrompts.ts "$root/new-frontend/public/spark" "$@"
