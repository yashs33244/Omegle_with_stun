#!/usr/bin/env sh
# Fails if docker-compose.yml reads a setting that the deploy cannot set, or
# if the backend reads a variable (backend/src/config.ts) that the compose
# file and the env examples do not know.
# deploy.sh rewrites .env from the GitHub secrets on every deploy, so a
# variable missing from its ENV_KEYS, from deploy.yml or from DEPLOYMENT.md
# can never be changed in production; a variable missing from compose never
# reaches a container at all.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
compose="$root/docker-compose.yml"
deploy_sh="$root/deploy/deploy.sh"
workflow="$root/.github/workflows/deploy.yml"
docs="$root/DEPLOYMENT.md"
config_ts="$root/backend/src/config.ts"
match_ts="$root/backend/src/match/matchConfig.ts"
root_example="$root/.env.example"
backend_example="$root/backend/.env.example"

# Set by deploy.sh or the workflow itself, baked in at build time, or only
# meant for local runs.
skip=" BACKEND_IMAGE FRONTEND_IMAGE IMAGE_TAG GATEWAY_CONF_VERSION VITE_API_URL VITE_SITE_URL BACKEND_PORT FRONTEND_PORT "

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

# Every variable the backend reads: the envSchema object in config.ts plus
# the MATCH_ENV object it spreads in.
config_vars=$(
  {
    sed -n '/^const envSchema = z/,/^  })/p' "$config_ts"
    sed -n '/^export const MATCH_ENV = {/,/^}/p' "$match_ts"
  } | grep -oE '^ +[A-Z_][A-Z0-9_]*:' | tr -d ' :' | sort -u
)
[ -n "$config_vars" ] || { echo "could not read the env schema from $config_ts" >&2; exit 1; }
compose_env=$(grep -oE '^      [A-Z_][A-Z0-9_]*:' "$compose" | tr -d ' :' | sort -u)
# Render only (render.yaml), or test only (refused in production).
not_in_compose=" KEEPALIVE_URL RENDER_EXTERNAL_URL PROXY_IP_HEADER RAZORPAY_FAKE "
# Fixed in docker-compose.yml, so not a .env setting.
not_in_root_example=" NODE_ENV PORT REDIS_URL TRUST_PROXY EVIDENCE_DIR "

while IFS= read -r var; do
  grep -q "^$var=" "$backend_example" || missing="$missing\n  $var: not in backend/.env.example"
  case "$not_in_compose" in *" $var "*) continue ;; esac
  printf '%s\n' "$compose_env" | grep -qx "$var" || missing="$missing\n  $var: read by backend/src/config.ts but not set in docker-compose.yml"
  case "$not_in_root_example" in *" $var "*) continue ;; esac
  grep -q "^$var=" "$root_example" || missing="$missing\n  $var: not in .env.example"
done <<EOF
$config_vars
EOF

if [ -n "$missing" ]; then
  printf 'docker-compose.yml reads settings the deploy cannot set, or the backend reads settings compose does not pass:%b\n' "$missing" >&2
  exit 1
fi
echo "every compose setting can be set through the deploy, and every backend setting reaches the container"
