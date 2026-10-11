#!/usr/bin/env sh
# Fails if docker-compose.yml reads a setting that the deploy cannot set.
# deploy.sh rewrites .env from the GitHub secrets on every deploy, so a
# variable missing from its ENV_KEYS, from deploy.yml or from DEPLOYMENT.md
# can never be changed in production.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
compose="$root/docker-compose.yml"
deploy_sh="$root/deploy/deploy.sh"
workflow="$root/.github/workflows/deploy.yml"
docs="$root/DEPLOYMENT.md"

# Set by deploy.sh or the workflow itself, baked in at build time, or only
# meant for local runs.
skip=" BACKEND_IMAGE FRONTEND_IMAGE IMAGE_TAG GATEWAY_CONF_VERSION VITE_API_URL BACKEND_PORT FRONTEND_PORT "

env_keys=$(sed -n '/^ENV_KEYS=(/,/^)/p' "$deploy_sh" | sed -e '1d' -e '$d' | tr -s ' ' '\n')
envs_list=$(sed -n 's/^ *envs: *//p' "$workflow" | tr ',' '\n' | tr -d ' ')

# shellcheck disable=SC2016 # a literal ${ is meant
compose_vars=$(grep -o '\${[A-Z_][A-Z0-9_]*' "$compose" | cut -c3- | sort -u)

missing=""
while IFS= read -r var; do
  case "$skip" in *" $var "*) continue ;; esac
  printf '%s\n' "$env_keys" | grep -qx "$var" || missing="$missing\n  $var: not in ENV_KEYS in deploy/deploy.sh"
  grep -Eq "^ +$var: \\\$\\{\\{ secrets\\.$var( |\\})" "$workflow" || missing="$missing\n  $var: not passed from secrets in the deploy step env of deploy.yml"
  printf '%s\n' "$envs_list" | grep -qx "$var" || missing="$missing\n  $var: not in the envs: list of deploy.yml"
  grep -q "\`$var\`" "$docs" || missing="$missing\n  $var: not documented in DEPLOYMENT.md"
done <<EOF
$compose_vars
EOF

if [ -n "$missing" ]; then
  printf 'docker-compose.yml reads settings the deploy cannot set:%b\n' "$missing" >&2
  exit 1
fi
echo "every compose setting can be set through the deploy"
