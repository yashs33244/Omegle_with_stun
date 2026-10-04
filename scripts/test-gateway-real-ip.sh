#!/usr/bin/env sh
# Checks which client address the gateway config derives from X-Forwarded-For.
# Runs the gateway image from docker-compose.yml with deploy/nginx/gateway.conf
# plus a probe server that echoes $remote_addr, then sends requests from inside
# the container (127.0.0.1, a trusted hop) with different forwarding chains.
# Needs docker.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
image=$(grep -o 'nginxinc/nginx-unprivileged:[^ "]*' "$root/docker-compose.yml" | head -n 1)
name="chizzy-gateway-realip-$$"
dir=$(mktemp -d)
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT

cp "$root/deploy/nginx/gateway.conf" "$dir/default.conf"
cat >"$dir/probe.conf" <<'EOF'
server {
    listen 8081;
    location / {
        default_type text/plain;
        return 200 "$remote_addr\n";
    }
}
EOF
chmod 755 "$dir"
chmod 644 "$dir/default.conf" "$dir/probe.conf"

docker run -d --rm --name "$name" \
  -v "$dir/default.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$dir/probe.conf:/etc/nginx/conf.d/probe.conf:ro" \
  "$image" >/dev/null

ready=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if docker exec "$name" wget -q -O /dev/null http://127.0.0.1:8081/ 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" != 1 ]; then
  docker logs "$name" >&2 || true
  echo "gateway did not start" >&2
  exit 1
fi

failed=0
check() {
  xff=$1
  want=$2
  got=$(docker exec "$name" wget -q -O - --header "X-Forwarded-For: $xff" http://127.0.0.1:8081/)
  if [ "$got" = "$want" ]; then
    echo "ok   X-Forwarded-For '$xff' -> $got"
  else
    echo "FAIL X-Forwarded-For '$xff' -> $got (want $want)" >&2
    failed=1
  fi
}

# Through Cloudflare: the edge address the host proxy appended is skipped.
check "203.0.113.7, 104.21.61.104" "203.0.113.7"
check "203.0.113.7, 172.67.208.243" "203.0.113.7"
check "203.0.113.7, 2606:4700::6810:3d68" "203.0.113.7"
# Through private hops only.
check "203.0.113.7, 10.0.0.5" "203.0.113.7"
# Any other public hop is the client; nothing to its left is believed.
check "203.0.113.7, 198.51.100.9" "198.51.100.9"
check "1.2.3.4, 198.51.100.9, 104.21.61.104" "198.51.100.9"

if [ "$failed" != 0 ]; then exit 1; fi
echo "gateway real client IP checks passed"
