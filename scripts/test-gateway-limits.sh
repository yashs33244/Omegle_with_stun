#!/usr/bin/env sh
# Checks the gateway's abuse limits (deploy/nginx): per-client rate limits,
# the exemption for local peers, the 404 for unknown paths and the slow
# client timeouts. Runs the gateway image from docker-compose.yml with the
# real nginx.conf and gateway.conf in a throwaway compose project, next to a
# stub "backend" that answers 200 to everything, and talks to the gateway on
# a loopback port. Needs docker (compose v2) and curl.
#
#   sh scripts/test-gateway-limits.sh [port]      (default 38080)
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
image=$(grep -o 'nginxinc/nginx-unprivileged:[^ "]*' "$root/docker-compose.yml" | head -n 1)
port=${1:-38080}
project="chizzy-gateway-limits-$$"
dir=$(mktemp -d)
# The stalled client below is a one-off `compose run` container, which
# `down` leaves behind; remove it by label.
trap 'docker compose -p "$project" -f "$dir/docker-compose.yml" down --timeout 1 >/dev/null 2>&1 || true; docker rm -f "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT

cat >"$dir/stub.conf" <<'EOF'
server {
    listen 3004;
    location / {
        default_type text/plain;
        return 200 "stub\n";
    }
}
EOF
cat >"$dir/docker-compose.yml" <<EOF
services:
  backend:
    image: $image
    volumes:
      - $dir/stub.conf:/etc/nginx/conf.d/default.conf:ro
  gateway:
    image: $image
    volumes:
      - $root/deploy/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - $root/deploy/nginx:/etc/nginx/chizzy:ro
    ports:
      - "127.0.0.1:$port:8080"
    depends_on: [backend]
EOF
chmod 755 "$dir"
chmod 644 "$dir/stub.conf" "$dir/docker-compose.yml"
docker compose -p "$project" -f "$dir/docker-compose.yml" up -d >/dev/null 2>&1

base="http://127.0.0.1:$port"
ready=0
for _ in $(seq 1 40); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$base/gateway-healthz")" = 200 ]; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" != 1 ]; then
  docker compose -p "$project" -f "$dir/docker-compose.yml" logs gateway >&2 || true
  echo "gateway did not start" >&2
  exit 1
fi

failed=0
ok() { echo "ok   $1"; }
fail() {
  echo "FAIL $1" >&2
  failed=1
}

# Counts the status codes of N requests sent at once (a flood, not a
# trickle: sequential requests would stay under the per-second rates), as
# "code count" lines.
codes() {
  n=$1
  shift
  out="$dir/codes.$$"
  : >"$out"
  i=0
  while [ "$i" -lt "$n" ]; do
    curl -s -o /dev/null -w '%{http_code}\n' "$@" >>"$out" &
    i=$((i + 1))
  done
  wait
  sort "$out" | uniq -c | awk '{ print $2, $1 }'
}
# Count of a status code in a codes() result (0 when absent).
count() { printf '%s\n' "$1" | awk -v c="$2" '$1 == c { n = $2 } END { print n + 0 }'; }

# A public client (X-Forwarded-For from the trusted loopback hop) gets the
# POST /api/session burst (20) plus the trickle, then 429.
got=$(codes 40 -X POST -H 'Content-Type: application/json' -H 'X-Forwarded-For: 198.51.100.9' -d '{}' "$base/api/session")
passed=$(count "$got" 200)
limited=$(count "$got" 429)
if [ "${limited:-0}" -ge 15 ] && [ "${passed:-0}" -ge 20 ] && [ "${passed:-0}" -le 25 ]; then
  ok "POST /api/session from one public address: $passed passed, $limited limited"
else
  fail "POST /api/session from one public address: want about 21 passed and the rest 429, got: $(printf '%s' "$got" | tr '\n' ' ')"
fi

# A different public address has its own budget.
got=$(codes 5 -X POST -H 'Content-Type: application/json' -H 'X-Forwarded-For: 203.0.113.7' -d '{}' "$base/api/session")
if [ "$(count "$got" 200)" = 5 ]; then
  ok "another public address is not affected"
else
  fail "another public address was limited: $(printf '%s' "$got" | tr '\n' ' ')"
fi

# Local peers (health checks, the compose network, e2e in CI) are exempt.
got=$(codes 60 -X POST -H 'Content-Type: application/json' -d '{}' "$base/api/session")
if [ "$(count "$got" 200)" = 60 ]; then
  ok "a local peer is never limited"
else
  fail "a local peer was limited: $(printf '%s' "$got" | tr '\n' ' ')"
fi

# Socket.IO handshakes: burst 20, then 5/s.
got=$(codes 40 -H 'X-Forwarded-For: 198.51.100.10' "$base/socket.io/?EIO=4&transport=websocket")
if [ "$(count "$got" 429 | sed "s/^$/0/")" -ge 10 ]; then
  ok "socket handshakes from one public address: $(count "$got" 429) limited"
else
  fail "socket handshakes from one public address were not limited: $(printf '%s' "$got" | tr '\n' ' ')"
fi

# Only the backend's routes are proxied.
for path in /foo /admin /metrics /.env; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-For: 198.51.100.11' "$base$path")
  if [ "$code" = 404 ]; then ok "$path -> 404 at the gateway"; else fail "$path -> $code (want 404)"; fi
done
for path in /healthz /readyz /health /api/config; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-For: 198.51.100.11' "$base$path")
  if [ "$code" = 200 ]; then ok "$path -> proxied"; else fail "$path -> $code (want 200)"; fi
done

# A connection that sends part of the headers and then stalls is answered
# 408 by client_header_timeout (10 s), not held for the 60 s default. The
# stalled client runs in a one-off container on the compose network (busybox
# nc keeps the connection open for 30 s); after 15 s the gateway must have
# logged the 408 already.
docker compose -p "$project" -f "$dir/docker-compose.yml" run -d --rm -T --no-deps --entrypoint sh gateway -c \
  '( printf "GET /healthz HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 198.51.100.12\r\n"; sleep 30 ) | nc gateway 8080' >/dev/null 2>&1
sleep 15
if docker compose -p "$project" -f "$dir/docker-compose.yml" logs --no-color gateway 2>/dev/null | grep -q '"GET /healthz HTTP/1.1" 408 '; then
  ok "a stalled request is answered 408 within 15 s (client_header_timeout)"
else
  fail "no 408 for the stalled request after 15 s (client_header_timeout is not in effect)"
fi

if [ "$failed" != 0 ]; then exit 1; fi
echo "gateway limit checks passed"
