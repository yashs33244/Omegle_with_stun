#!/usr/bin/env sh
# Copies the socket protocol from the backend (source of truth) to the frontend.
# Usage: scripts/sync-protocol.sh          copy
#        scripts/sync-protocol.sh --check  exit 1 if the copies differ (used in CI)
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/backend/src/protocol.ts"
dst="$root/new-frontend/src/lib/protocol.ts"

if [ "${1:-}" = "--check" ]; then
  if ! cmp -s "$src" "$dst"; then
    echo "protocol.ts is out of sync. Run scripts/sync-protocol.sh and commit the result." >&2
    exit 1
  fi
  echo "protocol.ts in sync"
  exit 0
fi

cp "$src" "$dst"
echo "copied $src -> $dst"
