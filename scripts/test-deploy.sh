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
  while IFS= read -r key; do
    case "$keys$own" in *" $key "*) ;; *) missing="$missing $key" ;; esac
  done < <(grep -oE '(^|[^$])\$\{[A-Z_][A-Z0-9_]*' "$root/docker-compose.yml" | sed 's/.*{//' | sort -u)
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

tmp_root=$(mktemp -d)
trap 'rm -rf "$tmp_root"' EXIT

# Stub docker and curl. `docker compose up` fails while .env selects
# $STUB_BAD_TAG; `docker compose pull` fails when $STUB_PULL_FAIL=1. Every
# docker call is logged to $STUB_LOG.
stub_bin="$tmp_root/bin"
mkdir -p "$stub_bin"
cat >"$stub_bin/docker" <<'EOF'
#!/bin/sh
echo "docker $*" >>"$STUB_LOG"
[ "$1" = compose ] || exit 0
case "$2" in
  pull) [ "${STUB_PULL_FAIL:-0}" != 1 ] ;;
  up) ! grep -qx "IMAGE_TAG=${STUB_BAD_TAG:-none}" .env ;;
  port) echo "0.0.0.0:18080" ;;
  *) exit 0 ;;
esac
EOF
printf '#!/bin/sh\nexit 0\n' >"$stub_bin/curl"
chmod +x "$stub_bin/docker" "$stub_bin/curl"

# Creates a host project directory as the deploy workflow leaves it: the
# running files (compose "old"), and .incoming/ with the compose file "new" and
# this repo's deploy/. Prints its path.
new_project() {
  local dir
  dir=$(mktemp -d "$tmp_root/project.XXXXXX")
  echo "old" >"$dir/docker-compose.yml"
  mkdir -p "$dir/deploy/nginx" "$dir/.incoming"
  echo "old" >"$dir/deploy/nginx/gateway.conf"
  echo "new" >"$dir/.incoming/docker-compose.yml"
  cp -Rp "$root/deploy" "$dir/.incoming/deploy"
  printf '%s' "$dir"
}

# Test values for the secrets a production backend needs. Never real secrets.
SESSION_TEST_SECRET=test-session-secret-0123456789abcdef
ADMIN_TEST_TOKEN=test-admin-token-0123456789
REQUIRED_SECRETS=(
  CORS_ORIGINS=https://app.example.com SESSION_SECRET="$SESSION_TEST_SECRET" ADMIN_TOKEN="$ADMIN_TEST_TOKEN"
  TURNSTILE_SECRET=test-turnstile-secret TURNSTILE_SITE_KEY=test-site-key PSEUDONYM_SALT=test-pseudonym-salt-0123
)

# Runs deploy.sh the way the workflow does (DEPLOY_WRITE_ENV=1) in a clean
# environment with the required secrets, plus any extra VAR=value arguments
# (later ones win). Output goes to $dir/out.
run_deploy() {
  local dir=$1
  shift
  (
    cd "$dir" &&
      env -i PATH="$stub_bin:$PATH" HOME="$HOME" STUB_LOG="$dir/docker.log" HEALTH_ATTEMPTS=1 HEALTH_INTERVAL=0 \
        DEPLOY_WRITE_ENV=1 BACKEND_IMAGE=example/backend FRONTEND_IMAGE=example/frontend \
        "${REQUIRED_SECRETS[@]}" "$@" bash .incoming/deploy/deploy.sh new-sha >"$dir/out" 2>&1
  )
}

# Fails the current test with the deploy output when a condition is false.
expect() {
  local name=$1 dir=$2
  shift 2
  if "$@"; then return 0; fi
  fail "$name: expected: $*"
  sed 's/^/     | /' "$dir/out" >&2
  return 1
}

file_is() { [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; }
not_pulled() { ! grep -q "compose pull" "$1/docker.log"; }
not_in() { ! grep -qF -- "$1" "$2"; }

test_deploy_success() {
  local name="a verified deploy keeps the old files in .previous/" dir
  dir=$(new_project)
  echo "old-sha" >"$dir/.deployed-tag"
  run_deploy "$dir" || { expect "$name" "$dir" false; return; }
  expect "$name" "$dir" file_is "$dir/.deployed-tag" "new-sha" &&
    expect "$name" "$dir" file_is "$dir/docker-compose.yml" "new" &&
    expect "$name" "$dir" file_is "$dir/.previous/docker-compose.yml" "old" &&
    expect "$name" "$dir" grep -qx "IMAGE_TAG=new-sha" "$dir/.env" &&
    pass "$name"
}

test_failed_deploy_rolls_back() {
  local name="a failed deploy restores the old files and tag" dir
  dir=$(new_project)
  echo "old-sha" >"$dir/.deployed-tag"
  if run_deploy "$dir" STUB_BAD_TAG=new-sha; then expect "$name" "$dir" false; return; fi
  expect "$name" "$dir" file_is "$dir/.deployed-tag" "old-sha" &&
    expect "$name" "$dir" file_is "$dir/docker-compose.yml" "old" &&
    expect "$name" "$dir" grep -qx "IMAGE_TAG=old-sha" "$dir/.env" &&
    pass "$name"
}

# The first deploy has no verified tag, so it cannot roll back by itself, but
# the files it replaces must survive in .previous/ for a manual recovery.
test_first_deploy_keeps_old_files() {
  local name="a failed first deploy keeps the old compose file in .previous/" dir
  dir=$(new_project)
  if run_deploy "$dir" STUB_BAD_TAG=new-sha; then expect "$name" "$dir" false; return; fi
  expect "$name" "$dir" file_is "$dir/.previous/docker-compose.yml" "old" &&
    expect "$name" "$dir" file_is "$dir/.previous/deploy/nginx/gateway.conf" "old" &&
    expect "$name" "$dir" grep -q "no previous verified tag" "$dir/out" &&
    pass "$name"
}

test_first_deploy_pull_failure_restores_files() {
  local name="a first deploy whose pull fails puts the old compose file back" dir
  dir=$(new_project)
  if run_deploy "$dir" STUB_PULL_FAIL=1; then expect "$name" "$dir" false; return; fi
  expect "$name" "$dir" file_is "$dir/docker-compose.yml" "old" &&
    pass "$name"
}

# A second failed first deploy must not overwrite the saved pre-deploy files
# with the unverified ones the first attempt installed.
test_repeated_first_deploy_keeps_original_files() {
  local name="a repeated failed first deploy keeps the original files in .previous/" dir
  dir=$(new_project)
  run_deploy "$dir" STUB_BAD_TAG=new-sha
  mkdir -p "$dir/.incoming"
  echo "newer" >"$dir/.incoming/docker-compose.yml"
  cp -Rp "$root/deploy" "$dir/.incoming/deploy"
  if run_deploy "$dir" STUB_BAD_TAG=new-sha; then expect "$name" "$dir" false; return; fi
  expect "$name" "$dir" file_is "$dir/.previous/docker-compose.yml" "old" &&
    pass "$name"
}

# A deploy that stops on a bad secret must not leave the new, unverified
# files installed: the next deploy would save them as the rollback copy.
test_invalid_env_changes_nothing() {
  local name="a secret with a single quote fails before any file is replaced" dir
  dir=$(new_project)
  echo "old-sha" >"$dir/.deployed-tag"
  mkdir -p "$dir/.previous"
  echo "older" >"$dir/.previous/docker-compose.yml"
  echo "IMAGE_TAG=old-sha" >"$dir/.env"
  if run_deploy "$dir" "REDIS_PASSWORD=it's"; then expect "$name" "$dir" false; return; fi
  expect "$name" "$dir" grep -q "REDIS_PASSWORD must not contain" "$dir/out" &&
    expect "$name" "$dir" file_is "$dir/docker-compose.yml" "old" &&
    expect "$name" "$dir" file_is "$dir/deploy/nginx/gateway.conf" "old" &&
    expect "$name" "$dir" file_is "$dir/.previous/docker-compose.yml" "older" &&
    expect "$name" "$dir" file_is "$dir/.env" "IMAGE_TAG=old-sha" &&
    expect "$name" "$dir" not_pulled "$dir" &&
    pass "$name"
}

test_missing_image_fails_before_install() {
  local name="a missing image name fails before any file is replaced" dir
  dir=$(new_project)
  echo "old-sha" >"$dir/.deployed-tag"
  if run_deploy "$dir" BACKEND_IMAGE=; then expect "$name" "$dir" false; return; fi
  expect "$name" "$dir" grep -q "BACKEND_IMAGE is required" "$dir/out" &&
    expect "$name" "$dir" file_is "$dir/docker-compose.yml" "old" &&
    pass "$name"
}

# The backend refuses to start without these in production; the deploy must
# say which one is missing before it replaces any file or pulls.
test_missing_secret_fails_before_install() {
  local name="a missing or short required secret fails before any file is replaced" dir
  dir=$(new_project)
  echo "old-sha" >"$dir/.deployed-tag"
  if run_deploy "$dir" SESSION_SECRET= ADMIN_TOKEN=too-short TURNSTILE_SITE_KEY=; then expect "$name" "$dir" false; return; fi
  expect "$name" "$dir" grep -q "missing or too short: SESSION_SECRET ADMIN_TOKEN TURNSTILE_SITE_KEY" "$dir/out" &&
    expect "$name" "$dir" not_in "too-short" "$dir/out" &&
    expect "$name" "$dir" file_is "$dir/docker-compose.yml" "old" &&
    expect "$name" "$dir" not_pulled "$dir" &&
    pass "$name"
}

test_evidence_bucket_needs_region() {
  local name="an evidence bucket without a region fails before any file is replaced" dir
  dir=$(new_project)
  if run_deploy "$dir" EVIDENCE_S3_BUCKET=evidence-bucket; then expect "$name" "$dir" false; return; fi
  expect "$name" "$dir" grep -q "missing or too short: EVIDENCE_S3_REGION" "$dir/out" &&
    expect "$name" "$dir" file_is "$dir/docker-compose.yml" "old" &&
    pass "$name"
}

test_turnstile_disabled_needs_no_keys() {
  local name="TURNSTILE_DISABLED=true deploys without Turnstile keys, with a warning" dir
  dir=$(new_project)
  run_deploy "$dir" TURNSTILE_DISABLED=true TURNSTILE_SECRET= TURNSTILE_SITE_KEY= || { expect "$name" "$dir" false; return; }
  expect "$name" "$dir" grep -q "WARNING: TURNSTILE_DISABLED" "$dir/out" &&
    expect "$name" "$dir" file_is "$dir/.deployed-tag" "new-sha" &&
    pass "$name"
}

test_secrets_written_but_not_printed() {
  local name="secrets reach .env (mode 600) and never the output" dir
  dir=$(new_project)
  run_deploy "$dir" || { expect "$name" "$dir" false; return; }
  expect "$name" "$dir" grep -qx "SESSION_SECRET='$SESSION_TEST_SECRET'" "$dir/.env" &&
    expect "$name" "$dir" grep -qx "ADMIN_TOKEN='$ADMIN_TEST_TOKEN'" "$dir/.env" &&
    expect "$name" "$dir" [ "$(stat -c %a "$dir/.env" 2>/dev/null || stat -f %Lp "$dir/.env")" = 600 ] &&
    expect "$name" "$dir" not_in "$SESSION_TEST_SECRET" "$dir/out" &&
    expect "$name" "$dir" not_in "$ADMIN_TEST_TOKEN" "$dir/out" &&
    pass "$name"
}

test_pseudonym_salt_warning() {
  local name="an empty PSEUDONYM_SALT deploys with a warning" dir
  dir=$(new_project)
  run_deploy "$dir" PSEUDONYM_SALT= || { expect "$name" "$dir" false; return; }
  expect "$name" "$dir" grep -q "WARNING: PSEUDONYM_SALT is empty" "$dir/out" &&
    pass "$name"
}

# A manual run (rollback by hand) checks the secrets already in .env.
test_manual_run_checks_env_file() {
  local name="a manual run with .env lacking ADMIN_TOKEN fails before any file is replaced" dir
  dir=$(new_project)
  echo "old-sha" >"$dir/.deployed-tag"
  printf "CORS_ORIGINS='https://app.example.com'\nSESSION_SECRET='%s'\nTURNSTILE_DISABLED='true'\n" "$SESSION_TEST_SECRET" >"$dir/.env"
  if run_deploy "$dir" DEPLOY_WRITE_ENV=0; then expect "$name" "$dir" false; return; fi
  expect "$name" "$dir" grep -q "missing or too short: ADMIN_TOKEN" "$dir/out" &&
    expect "$name" "$dir" file_is "$dir/docker-compose.yml" "old" &&
    pass "$name"
}

test_manual_run_without_env_fails_before_install() {
  local name="a manual run without .env fails before any file is replaced" dir
  dir=$(new_project)
  echo "old-sha" >"$dir/.deployed-tag"
  if run_deploy "$dir" DEPLOY_WRITE_ENV=0; then expect "$name" "$dir" false; return; fi
  expect "$name" "$dir" grep -q ".env is missing" "$dir/out" &&
    expect "$name" "$dir" file_is "$dir/docker-compose.yml" "old" &&
    pass "$name"
}

test_env_keys_cover_compose
test_env_keys_passed_by_workflow
test_manual_run_without_env_fails_before_install
test_manual_run_checks_env_file
test_invalid_env_changes_nothing
test_missing_secret_fails_before_install
test_evidence_bucket_needs_region
test_turnstile_disabled_needs_no_keys
test_secrets_written_but_not_printed
test_pseudonym_salt_warning
test_missing_image_fails_before_install
test_deploy_success
test_failed_deploy_rolls_back
test_first_deploy_keeps_old_files
test_first_deploy_pull_failure_restores_files
test_repeated_first_deploy_keeps_original_files

if [ "$failures" -ne 0 ]; then
  printf '%d deploy test(s) failed\n' "$failures" >&2
  exit 1
fi
echo "deploy tests passed"
