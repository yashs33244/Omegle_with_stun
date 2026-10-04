#!/usr/bin/env bash
# Tests for deploy/deploy.sh and the deploy workflow wiring. Needs only bash
# and coreutils (docker and curl are stubbed).
#
#   bash scripts/test-deploy.sh
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
failures=0

pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1" >&2
  failures=$((failures + 1))
}

# Prints the ENV_KEYS array from deploy.sh, one per line.
env_keys() {
  sed -n '/^ENV_KEYS=(/,/^)/p' "$root/deploy/deploy.sh" | sed -e '1d' -e '$d' | tr -s ' ' '\n' | sed '/^$/d'
}

# Every variable docker-compose.yml interpolates must reach .env on a workflow
# deploy (or be one deploy.sh writes itself), every ENV_KEYS entry must be
# passed by deploy.yml, and every one must be documented in DEPLOYMENT.md.
# Otherwise an operator can only set it by editing .env by hand, and the next
# deploy silently drops that edit.
test_env_keys_cover_compose() {
  local keys key missing=""
  keys=" $(env_keys | tr '\n' ' ') "
  # Written by deploy.sh itself, or only used to build images (not on the host).
  local own=" BACKEND_IMAGE FRONTEND_IMAGE IMAGE_TAG GATEWAY_CONF_VERSION VITE_API_URL "
  for key in $(grep -oE '(^|[^$])\$\{[A-Z_][A-Z0-9_]*' "$root/docker-compose.yml" | sed 's/.*{//' | sort -u); do
    case "$keys$own" in *" $key "*) ;; *) missing="$missing $key" ;; esac
  done
  if [ -z "$missing" ]; then
    pass "every compose variable is in ENV_KEYS or written by deploy.sh"
  else
    fail "compose variables missing from ENV_KEYS:$missing"
  fi
}

test_env_keys_passed_by_workflow() {
  local wf="$root/.github/workflows/deploy.yml" envs key missing_env="" missing_list="" missing_doc=""
  envs=",$(grep -E '^ +envs:' "$wf" | sed 's/.*envs: *//'),"
  for key in $(env_keys); do
    grep -qE "^ +$key: \\$\\{\\{ secrets\\.$key( |\\})" "$wf" || missing_env="$missing_env $key"
    case "$envs" in *",$key,"*) ;; *) missing_list="$missing_list $key" ;; esac
    grep -q "\`$key\`" "$root/DEPLOYMENT.md" || missing_doc="$missing_doc $key"
  done
  if [ -z "$missing_env$missing_list$missing_doc" ]; then
    pass "deploy.yml passes every ENV_KEYS entry and DEPLOYMENT.md documents it"
  else
    [ -z "$missing_env" ] || fail "deploy.yml env block lacks:$missing_env"
    [ -z "$missing_list" ] || fail "deploy.yml envs list lacks:$missing_list"
    [ -z "$missing_doc" ] || fail "DEPLOYMENT.md does not document:$missing_doc"
  fi
}

test_env_keys_cover_compose
test_env_keys_passed_by_workflow

if [ "$failures" -ne 0 ]; then
  printf '%d deploy test(s) failed\n' "$failures" >&2
  exit 1
fi
echo "deploy tests passed"
