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
# existing .env changes. Secret values are never printed. Either way the
# secrets a production backend needs are checked first, so a missing one stops
# the deploy before any file on the host changes.
#
# State kept next to .env:
#   .deployed-tag  last tag that passed verification (the rollback target)
#   .previous/     compose file and deploy/ that belong to that tag (before the
#                  first verified deploy: the files that deploy replaced)
#
# When .env has CLOUDFLARE_ONLY=true, every start refreshes the Cloudflare
# ranges and makes the gateway refuse requests that did not come through
# Cloudflare (deploy/cloudflare-ips.sh).
#
# Only dangling images are pruned. Volumes are never pruned (Redis data).

set -Eeuo pipefail

# Variables copied from the environment into .env when DEPLOY_WRITE_ENV=1.
# Every variable docker-compose.yml reads is here (scripts/test-deploy.sh
# checks it): .env is rewritten on every workflow deploy, so a value set only by
# editing .env by hand would be lost on the next deploy.
ENV_KEYS=(
  CORS_ORIGINS REDIS_PASSWORD BACKEND_REPLICAS BIND_ADDRESS BACKEND_PORT FRONTEND_PORT
  MAX_CONNECTIONS_PER_IP CONNECT_BURST_PER_IP CONNECT_RATE_PER_IP_PER_SEC MATCH_ACCEPT_TIMEOUT_MS SHUTDOWN_GRACE_MS
  STUN_URLS TURN_URLS TURN_SECRET TURN_USERNAME TURN_CREDENTIAL TURN_TTL_SECONDS
  METRICS_TOKEN LOG_LEVEL
  SESSION_SECRET SESSION_SECRET_PREVIOUS TURNSTILE_SECRET TURNSTILE_SITE_KEY TURNSTILE_DISABLED
  SESSION_RATE_PER_IP_PER_MIN SESSION_RATE_PER_NETWORK_PER_MIN SESSION_NEW_DEVICES_PER_NETWORK_PER_DAY
  MATCH_CAP_PER_DEVICE_PER_HOUR MATCH_CAP_PER_IP_PER_HOUR MATCH_CAP_PER_DEVICE_PER_MIN
  TRUST_CLOUDFLARE TURN_PROVIDER CF_TURN_KEY_ID CF_TURN_API_TOKEN CF_ACCOUNT_ID CF_ANALYTICS_TOKEN
  TURN_CACHE_SECONDS TURN_MAX_PER_DEVICE_HOUR TURN_MAX_PER_IP_HOUR TURN_SPEND_DAILY_GB
  SENTRY_DSN SENTRY_DSN_FRONTEND POSTHOG_KEY POSTHOG_HOST
  ADMIN_TOKEN ADMIN_ALLOWED_IPS PSEUDONYM_SALT
  EVIDENCE_S3_BUCKET EVIDENCE_S3_REGION EVIDENCE_S3_KMS_KEY_ID
  RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET
  CLOUDFLARE_ONLY BACKUP_S3_URI
)
installed=0
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-180}"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

# Checks what write_env (or set_release) will need. Runs before any file is
# replaced, so a bad secret cannot leave unverified files installed (the next
# deploy would save them in .previous/ as the rollback copy).
validate_env() {
  local key
  if [ "${DEPLOY_WRITE_ENV:-0}" != "1" ]; then
    [ -f .env ] || die ".env is missing; run the deploy workflow once to create it"
    check_production_secrets
    return 0
  fi
  [ -n "${BACKEND_IMAGE:-}" ] || die "BACKEND_IMAGE is required"
  [ -n "${FRONTEND_IMAGE:-}" ] || die "FRONTEND_IMAGE is required"
  for key in "${ENV_KEYS[@]}"; do
    case "${!key-}" in
      *"'"* | *$'\n'*) die "$key must not contain a single quote or newline" ;;
    esac
  done
  check_production_secrets
}

# Value a setting will have in .env: from the environment when this run
# writes .env, otherwise from the existing .env.
setting() {
  if [ "${DEPLOY_WRITE_ENV:-0}" = "1" ]; then printf '%s' "${!1-}"; else env_value "$1"; fi
}

# The backend refuses to start in production without these (config.ts), which
# would only show up as a failed health check and a rollback. Checking here
# stops the deploy before anything on the host changes, and names the secret.
check_production_secrets() {
  local missing="" key min val
  # Minimum lengths match backend/src/config.ts.
  for key in CORS_ORIGINS:1 SESSION_SECRET:32 ADMIN_TOKEN:24; do
    min=${key#*:}
    key=${key%%:*}
    val=$(setting "$key")
    [ "${#val}" -ge "$min" ] || missing="$missing $key"
  done
  case "$(setting TURNSTILE_DISABLED)" in
    true | 1 | yes) log "WARNING: TURNSTILE_DISABLED is set; the session gate does not check for bots" ;;
    *)
      [ -n "$(setting TURNSTILE_SECRET)" ] || missing="$missing TURNSTILE_SECRET"
      [ -n "$(setting TURNSTILE_SITE_KEY)" ] || missing="$missing TURNSTILE_SITE_KEY"
      ;;
  esac
  if [ -n "$(setting EVIDENCE_S3_BUCKET)" ] && [ -z "$(setting EVIDENCE_S3_REGION)" ]; then
    missing="$missing EVIDENCE_S3_REGION"
  fi
  if [ -n "$(setting RAZORPAY_KEY_ID)" ]; then
    [ -n "$(setting RAZORPAY_KEY_SECRET)" ] || missing="$missing RAZORPAY_KEY_SECRET"
    [ -n "$(setting RAZORPAY_WEBHOOK_SECRET)" ] || missing="$missing RAZORPAY_WEBHOOK_SECRET"
  fi
  val=$(setting PSEUDONYM_SALT)
  if [ -z "$val" ]; then
    log "WARNING: PSEUDONYM_SALT is empty; admin pseudonyms come from ADMIN_TOKEN and change when it is rotated"
  elif [ "${#val}" -lt 16 ]; then
    missing="$missing PSEUDONYM_SALT"
  fi
  [ -z "$missing" ] ||
    die "missing or too short:$missing (set the GitHub secrets; DEPLOYMENT.md, \"First deploy of the launch build\")"
}

# Writes .env from the environment. Call validate_env first.
write_env() {
  local tmp key val
  tmp=$(mktemp "$PWD/.env.XXXXXX")
  chmod 600 "$tmp"
  {
    echo "# Written by deploy/deploy.sh from GitHub secrets. Edit the secrets, not this file."
    printf 'BACKEND_IMAGE=%s\nFRONTEND_IMAGE=%s\n' "$BACKEND_IMAGE" "$FRONTEND_IMAGE"
    for key in "${ENV_KEYS[@]}"; do
      val="${!key-}"
      # Single quotes keep compose from interpolating $ in values.
      if [ -n "$val" ]; then printf "%s='%s'\n" "$key" "$val"; fi
    done
  } >"$tmp"
  mv -f "$tmp" .env
  log "wrote .env ($(grep -c '=' .env) entries, values not shown)"
}

# Value of KEY in .env (without the quotes write_env adds), or empty.
env_value() {
  sed -n "s/^$1=//p" .env | tail -n 1 | sed -e "s/^'//" -e "s/'\$//"
}

# Refreshes the Cloudflare ranges and writes the gateway rule for
# CLOUDFLARE_ONLY from .env (true: refuse requests that did not come through
# Cloudflare; anything else: no rule). The existing list is kept if the
# download fails, so this never blocks a deploy or a rollback.
refresh_cloudflare() {
  CLOUDFLARE_ONLY="$(env_value CLOUDFLARE_ONLY)" sh deploy/cloudflare-ips.sh deploy/nginx ||
    log "WARNING: cloudflare-ips.sh failed; the gateway keeps its current Cloudflare files"
}

# Records the image tag to run, plus a checksum of deploy/nginx/: the gateway
# bind-mounts those files, so a changed checksum (a compose label) makes
# compose recreate the container and nginx load the new config.
set_release() {
  local tag=$1 tmp conf
  [ -f .env ] || die ".env is missing; run the deploy workflow once to create it"
  refresh_cloudflare
  conf=$(cat deploy/nginx/* | cksum | cut -d ' ' -f 1)
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
  # Replace the saved copy only when the running files belong to a verified
  # tag. The first deploy (no verified tag yet) still saves the files it
  # replaces, once, so they can be put back by hand; a retry after a failed
  # first deploy keeps that copy instead of saving the unverified files.
  if [ -f .deployed-tag ] || [ ! -d .previous ]; then
    rm -rf .previous && mv .previous.tmp .previous
  else
    rm -rf .previous.tmp
  fi
  cp -p .incoming/docker-compose.yml docker-compose.yml
  rm -rf deploy
  cp -Rp .incoming/deploy deploy
  # Host scripts (scripts/backup-redis.sh for cron). Not part of the rollback.
  if [ -d .incoming/scripts ]; then rm -rf scripts && cp -Rp .incoming/scripts scripts; fi
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

  validate_env
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
