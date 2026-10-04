#!/usr/bin/env bash
# Deploys one image tag on the host, with health verification and automatic
# rollback. Run from the project directory (the one holding docker-compose.yml
# and .env):
#
#   bash deploy/deploy.sh <image-tag>               manual deploy or rollback
#   bash .incoming/deploy/deploy.sh <image-tag>     what the deploy workflow runs
#
# When .incoming/ exists (the workflow copies the new docker-compose.yml and
# deploy/ there), the current files are saved to .previous/ and the new ones
# installed. When DEPLOY_WRITE_ENV=1, .env is rewritten from the environment
# (the workflow passes the GitHub secrets); otherwise only IMAGE_TAG in the
# existing .env changes. Secret values are never printed.
#
# State kept next to .env:
#   .deployed-tag  last tag that passed verification (the rollback target)
#   .previous/     compose file and deploy/ that belong to that tag
#
# Only dangling images are pruned. Volumes are never pruned (Redis data).

set -Eeuo pipefail

# Variables copied from the environment into .env when DEPLOY_WRITE_ENV=1.
ENV_KEYS=(
  CORS_ORIGINS REDIS_PASSWORD BACKEND_REPLICAS BIND_ADDRESS
  STUN_URLS TURN_URLS TURN_SECRET TURN_USERNAME TURN_CREDENTIAL TURN_TTL_SECONDS
  TURN_REALM TURN_EXTERNAL_IP METRICS_TOKEN LOG_LEVEL
  MAX_CONNECTIONS_PER_IP MATCH_ACCEPT_TIMEOUT_MS SHUTDOWN_GRACE_MS
)
installed=0
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-180}"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

write_env() {
  local tmp key val
  : "${BACKEND_IMAGE:?BACKEND_IMAGE is required}"
  : "${FRONTEND_IMAGE:?FRONTEND_IMAGE is required}"
  for key in "${ENV_KEYS[@]}"; do
    case "${!key-}" in
      *"'"* | *$'\n'*) die "$key must not contain a single quote or newline" ;;
    esac
  done
  tmp=$(mktemp "$PWD/.env.XXXXXX")
  chmod 600 "$tmp"
  {
    echo "# Written by deploy/deploy.sh from GitHub secrets. Edit the secrets, not this file."
    printf 'BACKEND_IMAGE=%s\nFRONTEND_IMAGE=%s\n' "$BACKEND_IMAGE" "$FRONTEND_IMAGE"
    if [ "${RUN_COTURN:-}" = "true" ]; then echo "COMPOSE_PROFILES=turn"; fi
    for key in "${ENV_KEYS[@]}"; do
      val="${!key-}"
      # Single quotes keep compose from interpolating $ in values.
      if [ -n "$val" ]; then printf "%s='%s'\n" "$key" "$val"; fi
    done
  } >"$tmp"
  mv -f "$tmp" .env
  log "wrote .env ($(grep -c '=' .env) entries, values not shown)"
}

# Records the image tag to run, plus a checksum of the gateway config: the
# gateway bind-mounts that file, so a changed checksum (a compose label) makes
# compose recreate the container and nginx load the new config.
set_release() {
  local tag=$1 tmp conf
  [ -f .env ] || die ".env is missing; run the deploy workflow once to create it"
  conf=$(cksum <deploy/nginx/gateway.conf | cut -d ' ' -f 1)
  tmp=$(mktemp "$PWD/.env.XXXXXX")
  chmod 600 "$tmp"
  grep -v -e '^IMAGE_TAG=' -e '^GATEWAY_CONF_VERSION=' .env >"$tmp" || true
  printf 'IMAGE_TAG=%s\nGATEWAY_CONF_VERSION=%s\n' "$tag" "$conf" >>"$tmp"
  mv -f "$tmp" .env
}

install_incoming() {
  [ -d .incoming ] || return 0
  [ -f .incoming/docker-compose.yml ] || die ".incoming/docker-compose.yml is missing"
  rm -rf .previous.tmp
  mkdir -p .previous.tmp
  if [ -f docker-compose.yml ]; then cp -p docker-compose.yml .previous.tmp/; fi
  if [ -d deploy ]; then cp -Rp deploy .previous.tmp/; fi
  # Only replace the saved copy when the running files belong to a verified tag.
  if [ -f .deployed-tag ]; then rm -rf .previous && mv .previous.tmp .previous; else rm -rf .previous.tmp; fi
  cp -p .incoming/docker-compose.yml docker-compose.yml
  rm -rf deploy
  cp -Rp .incoming/deploy deploy
  rm -rf .incoming
  installed=1
  log "installed new docker-compose.yml and deploy/"
}

# Puts back the files saved by install_incoming (only if this run installed new ones).
restore_previous() {
  [ "$installed" = 1 ] && [ -d .previous ] || return 0
  if [ -f .previous/docker-compose.yml ]; then cp -p .previous/docker-compose.yml docker-compose.yml; fi
  if [ -d .previous/deploy ]; then rm -rf deploy && cp -Rp .previous/deploy deploy; fi
  log "restored docker-compose.yml and deploy/ from .previous/"
}

# Prints host:port for a published service port, using loopback for 0.0.0.0.
endpoint() {
  local addr
  addr=$(docker compose port "$1" 8080 | head -n 1)
  [ -n "$addr" ] || return 1
  printf '%s' "${addr/0.0.0.0/127.0.0.1}"
}

verify() {
  local gw fe i
  gw=$(endpoint gateway) || { log "gateway has no published port"; return 1; }
  fe=$(endpoint frontend) || { log "frontend has no published port"; return 1; }
  for ((i = 1; i <= HEALTH_ATTEMPTS; i++)); do
    if curl -fsS -m 5 -o /dev/null "http://$gw/healthz" &&
      curl -fsS -m 5 -o /dev/null "http://$gw/readyz" &&
      curl -fsS -m 5 -o /dev/null "http://$fe/healthz"; then
      log "healthy: gateway /healthz and /readyz on $gw, frontend /healthz on $fe"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
  done
  log "health verification failed after $HEALTH_ATTEMPTS attempts"
  return 1
}

show_state() {
  docker compose ps || true
  docker compose logs --no-color --tail=50 backend gateway frontend || true
}

# Starts the given tag and verifies it. Returns non-zero on failure.
start_tag() {
  local tag=$1
  set_release "$tag"
  log "starting tag $tag"
  docker compose up -d --no-build --remove-orphans --wait --wait-timeout "$WAIT_TIMEOUT" || return 1
  verify
}

main() {
  local new_tag=${1:-} prev_tag=""
  [ -n "$new_tag" ] || die "usage: deploy.sh <image-tag>"
  # .env is the single source of truth for these; a value exported in the
  # shell would override it and break rollback.
  unset IMAGE_TAG GATEWAY_CONF_VERSION
  command -v docker >/dev/null || die "docker is not installed"
  command -v curl >/dev/null || die "curl is not installed"
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed"

  if [ -f .deployed-tag ]; then prev_tag=$(cat .deployed-tag); fi
  log "deploying $new_tag (previous verified tag: ${prev_tag:-none})"

  install_incoming
  if [ "${DEPLOY_WRITE_ENV:-0}" = "1" ]; then write_env; fi
  set_release "$new_tag"

  # Pull first: if an image is missing nothing running is touched.
  if ! docker compose pull --quiet; then
    restore_previous
    if [ -n "$prev_tag" ]; then set_release "$prev_tag"; fi
    die "image pull failed; the running stack was not changed"
  fi

  if start_tag "$new_tag"; then
    printf '%s\n' "$new_tag" >.deployed-tag
    docker image prune -f >/dev/null
    log "deployed $new_tag"
    return 0
  fi

  log "deploy of $new_tag failed"
  show_state
  if [ -z "$prev_tag" ] || [ "$prev_tag" = "$new_tag" ]; then
    die "no previous verified tag to roll back to"
  fi
  log "rolling back to $prev_tag"
  restore_previous
  if start_tag "$prev_tag"; then
    die "rolled back to $prev_tag; $new_tag is NOT deployed"
  fi
  show_state
  die "rollback to $prev_tag also failed; manual action needed"
}

# Everything runs inside main so bash has parsed the whole file before
# install_incoming replaces it on disk.
main "$@"
exit $?
