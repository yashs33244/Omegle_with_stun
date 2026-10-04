#!/usr/bin/env bash
# Snapshots the compose stack's Redis (BGSAVE), keeps a local copy and, when
# BACKUP_S3_URI is set, uploads it to S3 with the AWS CLI. Restore steps are
# in docs/redis-backup.md.
#
# Run on the host, in the directory that holds docker-compose.yml and .env:
#
#   bash scripts/backup-redis.sh
#
# Nightly from cron (the deploy keeps this script in scripts/ on the host):
#
#   15 3 * * * cd ~/Omegle_with_stun && bash scripts/backup-redis.sh >> backups/redis-backup.log 2>&1
#
# Environment (each can also be set in .env, the environment wins):
#   BACKUP_S3_URI     s3://bucket/prefix; empty keeps local copies only
#   BACKUP_DIR        local directory (default backups/redis)
#   BACKUP_KEEP       local copies to keep (default 7)
#   BACKUP_S3_SSE     server-side encryption for the upload (default AES256; aws:kms for KMS)
#   BACKUP_TIMEOUT    seconds to wait for BGSAVE (default 600)
#
# S3 credentials come from the EC2 instance role (or the usual AWS CLI
# configuration). The role needs s3:PutObject on the prefix only. Give the
# bucket a lifecycle rule that matches docs/retention.md.

set -Eeuo pipefail

log() { printf '[backup-redis] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# Value of KEY from .env (without surrounding single quotes), or empty.
from_env_file() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1 | sed -e "s/^'//" -e "s/'\$//"
}

BACKUP_S3_URI=${BACKUP_S3_URI-$(from_env_file BACKUP_S3_URI)}
BACKUP_DIR=${BACKUP_DIR:-$(from_env_file BACKUP_DIR)}
BACKUP_DIR=${BACKUP_DIR:-backups/redis}
BACKUP_KEEP=${BACKUP_KEEP:-$(from_env_file BACKUP_KEEP)}
BACKUP_KEEP=${BACKUP_KEEP:-7}
BACKUP_S3_SSE=${BACKUP_S3_SSE:-$(from_env_file BACKUP_S3_SSE)}
BACKUP_S3_SSE=${BACKUP_S3_SSE:-AES256}
BACKUP_TIMEOUT=${BACKUP_TIMEOUT:-$(from_env_file BACKUP_TIMEOUT)}
BACKUP_TIMEOUT=${BACKUP_TIMEOUT:-600}
case "$BACKUP_KEEP" in "" | *[!0-9]* | 0) die "BACKUP_KEEP must be a number of at least 1" ;; esac

[ -f docker-compose.yml ] || die "run this in the directory that holds docker-compose.yml"
command -v docker >/dev/null || die "docker is not installed"
if [ -n "$BACKUP_S3_URI" ]; then
  command -v aws >/dev/null || die "BACKUP_S3_URI is set but the aws CLI is not installed"
  case "$BACKUP_S3_URI" in s3://*) ;; *) die "BACKUP_S3_URI must start with s3://" ;; esac
fi

# redis-cli inside the redis container. The password stays inside the
# container (its REDIS_PASSWORD), so it never appears in this host's process list.
rcli() {
  # shellcheck disable=SC2016 # expanded by the container's shell
  docker compose exec -T redis sh -c 'exec redis-cli ${REDIS_PASSWORD:+--no-auth-warning -a "$REDIS_PASSWORD"} "$@"' redis-cli "$@"
}

rcli PING | grep -q PONG || die "redis is not answering (is the stack up?)"
data_dir=$(rcli CONFIG GET dir | sed -n 2p)
rdb_name=$(rcli CONFIG GET dbfilename | sed -n 2p)
[ -n "$data_dir" ] && [ -n "$rdb_name" ] || die "could not read the RDB location from redis"

# rdb_saves counts finished snapshots (Redis 7+); LASTSAVE has 1 s resolution.
saves() { rcli INFO persistence | tr -d '\r' | sed -n 's/^rdb_saves://p'; }
before=$(saves)
[ -n "$before" ] || die "redis did not report rdb_saves (Redis 7 or newer is required)"
reply=$(rcli BGSAVE || true)
case "$reply" in
  *"started"* | *"in progress"* | *"scheduled"*) log "BGSAVE: $reply" ;;
  *) die "BGSAVE failed: $reply" ;;
esac

deadline=$((SECONDS + BACKUP_TIMEOUT))
while :; do
  if [ "$(saves)" != "$before" ] && ! rcli INFO persistence | grep -q '^rdb_bgsave_in_progress:1'; then break; fi
  [ "$SECONDS" -lt "$deadline" ] || die "BGSAVE did not finish within ${BACKUP_TIMEOUT}s"
  sleep 1
done
rcli INFO persistence | grep -q '^rdb_last_bgsave_status:ok' || die "the last BGSAVE did not succeed (see redis logs)"

umask 077
mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="$BACKUP_DIR/redis-$stamp.rdb"
docker compose cp "redis:$data_dir/$rdb_name" "$file" >/dev/null
chmod 600 "$file"
[ "$(head -c 5 "$file")" = "REDIS" ] || die "$file does not look like an RDB file"
log "saved $file ($(wc -c <"$file" | tr -d ' ') bytes)"

if [ -n "$BACKUP_S3_URI" ]; then
  dest="${BACKUP_S3_URI%/}/redis-$stamp.rdb"
  aws s3 cp "$file" "$dest" --only-show-errors --sse "$BACKUP_S3_SSE"
  log "uploaded to $dest"
else
  log "BACKUP_S3_URI is empty: local copy only"
fi

# Keep the newest BACKUP_KEEP local copies (names sort by time).
count=$(find "$BACKUP_DIR" -maxdepth 1 -name 'redis-*.rdb' | wc -l | tr -d ' ')
if [ "$count" -gt "$BACKUP_KEEP" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -name 'redis-*.rdb' | sort | head -n "$((count - BACKUP_KEEP))" |
    while IFS= read -r old; do rm -f -- "$old"; done
  log "removed $((count - BACKUP_KEEP)) older local copies"
fi
