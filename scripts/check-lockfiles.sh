#!/usr/bin/env sh
# Fails if a lockfile points at a registry other than the public npm registry,
# or if the frontend lockfile is degraded: entries without resolved/integrity
# (written when the registry could not be reached) or without the Linux
# platform packages (written on a Mac without registry metadata), either of
# which breaks `npm ci && npm run build` in the Dockerfile and on CI runners.
# Lockfiles generated behind a private package mirror record its tarball URLs,
# which breaks installs everywhere else and leaks internal hostnames.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/new-frontend/package-lock.json"
bad=$(
  {
    grep -o '"resolved": "[^"]*"' "$lock" | grep -v '"https://registry.npmjs.org/' || true
    grep -o '"https\{0,1\}://[^"]*\.tgz"' "$root/backend/bun.lock" | grep -v '"https://registry.npmjs.org/' || true
  } | head -5
)
if [ -n "$bad" ]; then
  echo "Lockfiles reference a non-public registry, for example:" >&2
  echo "$bad" >&2
  echo "Regenerate them against https://registry.npmjs.org before committing." >&2
  exit 1
fi

# shellcheck disable=SC2016 # the ${...} below is a JavaScript template literal, not shell
degraded=$(node -e '
  const { packages } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const missing = Object.entries(packages)
    .filter(([key, entry]) => key !== "" && !entry.link && !(entry.resolved && entry.integrity))
    .map(([key]) => key);
  if (missing.length) console.log(`${missing.length} entries lack resolved/integrity, for example:\n  ${missing.slice(0, 5).join("\n  ")}`);
  if (packages["node_modules/rollup"] && !packages["node_modules/@rollup/rollup-linux-x64-gnu"]) {
    console.log("rollup is present but @rollup/rollup-linux-x64-gnu is not: the Linux platform packages are missing");
  }
' "$lock")
if [ -n "$degraded" ]; then
  echo "new-frontend/package-lock.json is degraded:" >&2
  echo "$degraded" >&2
  echo "Regenerate it against https://registry.npmjs.org (npm install --package-lock-only --registry=https://registry.npmjs.org) before committing." >&2
  exit 1
fi
echo "lockfiles use the public npm registry and are complete"
