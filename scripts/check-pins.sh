#!/usr/bin/env sh
# Fails if the runtime and image versions pinned in .github/workflows/ci.yml
# differ from the ones the images and compose file use. Dependabot bumps the
# Dockerfiles and docker-compose.yml but not these copies, and CI would then
# keep testing the old versions.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
ci="$root/.github/workflows/ci.yml"
compose="$root/docker-compose.yml"
failed=0

# Prints the distinct matches of an extended regex in the given files.
pins() {
  pattern=$1
  shift
  grep -ohE "$pattern" "$@" | sort -u
}

same() {
  what=$1 ci_pin=$2 want=$3 source=$4
  if [ -z "$ci_pin" ] || [ -z "$want" ]; then
    echo "FAIL $what: could not read the pin (ci.yml: '$ci_pin', $source: '$want')" >&2
    failed=1
  elif [ "$ci_pin" != "$want" ]; then
    echo "FAIL $what: ci.yml pins $ci_pin; $source: $(echo "$want" | tr '\n' ' ')" >&2
    failed=1
  else
    echo "ok   $what $ci_pin"
  fi
}

ci_node=$(pins 'NODE_VERSION: "[^"]*"' "$ci" | sed 's/.*: "\(.*\)"/\1/')
docker_node=$(pins 'FROM node:[0-9][0-9.]*' "$root/backend/Dockerfile" "$root/new-frontend/Dockerfile" | sed 's/.*://')
same "Node" "$ci_node" "$docker_node" "the Dockerfiles"

ci_bun=$(pins 'BUN_VERSION: "[^"]*"' "$ci" | sed 's/.*: "\(.*\)"/\1/')
docker_bun=$(pins 'FROM oven/bun:[0-9][0-9.]*' "$root/backend/Dockerfile" | sed 's/.*://')
same "Bun" "$ci_bun" "$docker_bun" "backend/Dockerfile"

redis='image: redis:[^ "]*'
same "Redis image" "$(pins "$redis" "$ci" | sed 's/image: //')" "$(pins "$redis" "$compose" | sed 's/image: //')" "docker-compose.yml"

nginx='nginxinc/nginx-unprivileged:[^ "]*'
same "gateway nginx image" "$(pins "$nginx" "$ci")" "$(pins "$nginx" "$compose")" "docker-compose.yml"

if [ "$failed" != 0 ]; then
  echo "Update the pins in ci.yml to match." >&2
  exit 1
fi
echo "ci.yml pins match the Dockerfiles and docker-compose.yml"
