#!/usr/bin/env sh
# Fails if a lockfile points at a registry other than the public npm registry.
# Lockfiles generated behind a private package mirror record its tarball URLs,
# which breaks installs everywhere else and leaks internal hostnames.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
bad=$(
  {
    grep -o '"resolved": "[^"]*"' "$root/new-frontend/package-lock.json" | grep -v '"https://registry.npmjs.org/' || true
    grep -o '"https\{0,1\}://[^"]*\.tgz"' "$root/backend/bun.lock" | grep -v '"https://registry.npmjs.org/' || true
  } | head -5
)
if [ -n "$bad" ]; then
  echo "Lockfiles reference a non-public registry, for example:" >&2
  echo "$bad" >&2
  echo "Regenerate them against https://registry.npmjs.org before committing." >&2
  exit 1
fi
echo "lockfiles use the public npm registry"
