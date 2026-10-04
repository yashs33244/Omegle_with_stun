#!/usr/bin/env bash
# Restores a snapshot made by scripts/backup-redis.sh into the compose stack's
# Redis volume. Run on the host, in the directory that holds docker-compose.yml:
#
#   bash scripts/restore-redis.sh backups/redis/redis-<stamp>.rdb --yes
#   bash scripts/restore-redis.sh s3://bucket/prefix/redis-<stamp>.rdb --yes
#
# This is an outage: the backend is stopped while Redis is replaced, which
# drops every live call. Steps (docs/redis-backup.md explains why):
#   1. stop backend and redis
#   2. in a one-off redis container: move the current AOF and dump.rdb aside
#      (kept as *.before-restore-<time>, nothing is deleted), load the snapshot
#      with AOF off, turn AOF on so Redis rewrites it from the restored data,
#      and shut down cleanly
#   3. start the whole stack again and print the key count
set -Eeuo pipefail

log() { printf '[restore-redis] %s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

src=${1:-}
[ -n "$src" ] || die "usage: restore-redis.sh <snapshot.rdb | s3://...> --yes"
[ "${2:-}" = "--yes" ] || die "this stops the backend and replaces Redis data; add --yes to confirm"
[ -f docker-compose.yml ] || die "run this in the directory that holds docker-compose.yml"

tmp=""
trap '[ -n "$tmp" ] && rm -f "$tmp"' EXIT
case "$src" in
  s3://*)
    command -v aws >/dev/null || die "the aws CLI is needed for an s3:// snapshot"
    umask 077
    tmp=$(mktemp)
    aws s3 cp "$src" "$tmp" --only-show-errors
    file=$tmp
    ;;
  *) file=$src ;;
esac
[ -f "$file" ] || die "no such file: $file"
[ "$(head -c 5 "$file")" = "REDIS" ] || die "$file does not look like an RDB file"

log "stopping backend and redis"
docker compose stop backend redis

log "loading the snapshot into the redis-data volume"
# The snapshot goes in on stdin, so file permissions on the host do not matter.
# shellcheck disable=SC2016 # runs in the container's shell
docker compose run --rm --no-deps -T --entrypoint sh redis -c '
  set -eu
  now=$(date +%s)
  cat >/data/restore.rdb
  if [ -d /data/appendonlydir ]; then mv /data/appendonlydir "/data/appendonlydir.before-restore-$now"; fi
  if [ -f /data/dump.rdb ]; then mv /data/dump.rdb "/data/dump.rdb.before-restore-$now"; fi
  mv /data/restore.rdb /data/dump.rdb
  redis-server --dir /data --appendonly no --port 6399 --bind 127.0.0.1 --daemonize yes --logfile /data/restore.log
  i=0
  until redis-cli -p 6399 PING 2>/dev/null | grep -q PONG; do
    i=$((i + 1)); [ "$i" -lt 1200 ] || { echo "redis did not finish loading the snapshot" >&2; exit 1; }; sleep 0.5
  done
  echo "[restore-redis] snapshot loaded: $(redis-cli -p 6399 DBSIZE) keys"
  redis-cli -p 6399 CONFIG SET appendonly yes >/dev/null
  i=0
  until info=$(redis-cli -p 6399 INFO persistence | tr -d "\r") &&
    echo "$info" | grep -q "^aof_rewrite_in_progress:0" &&
    echo "$info" | grep -q "^aof_rewrite_scheduled:0" &&
    ls /data/appendonlydir/*.manifest >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 1200 ] || { echo "the AOF rewrite did not finish" >&2; exit 1; }; sleep 0.5
  done
  echo "$info" | grep -q "^aof_last_bgrewrite_status:ok" || { echo "the AOF rewrite failed" >&2; exit 1; }
  redis-cli -p 6399 SHUTDOWN >/dev/null 2>&1 || true
  i=0
  while redis-cli -p 6399 PING >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 120 ] || { echo "redis did not shut down" >&2; exit 1; }; sleep 0.5
  done
  rm -f /data/restore.log
  echo "[restore-redis] AOF rebuilt from the snapshot"
' <"$file"

log "starting the stack"
docker compose up -d --no-build --wait
# shellcheck disable=SC2016 # expanded by the container's shell
keys=$(docker compose exec -T redis sh -c 'exec redis-cli ${REDIS_PASSWORD:+--no-auth-warning -a "$REDIS_PASSWORD"} DBSIZE')
log "done: redis has $keys keys. The old data is in the volume as *.before-restore-*; remove it once you are sure."
