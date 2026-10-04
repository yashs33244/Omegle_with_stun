#!/usr/bin/env sh
# Checks which client address and country the gateway hands to the backend.
# Runs the gateway image from docker-compose.yml with deploy/nginx (nginx.conf,
# gateway.conf and its includes) plus a probe server that echoes what the
# gateway derived: $remote_addr after the X-Forwarded-For walk, the client IP
# it sends as X-Real-IP, and the CF-IPCountry it passes on. Requests are sent
# from inside the container (127.0.0.1, a trusted hop) with different
# forwarding chains. Needs docker.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
image=$(grep -o 'nginxinc/nginx-unprivileged:[^ "]*' "$root/docker-compose.yml" | head -n 1)
name="chizzy-gateway-realip-$$"
dir=$(mktemp -d)
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT

mkdir "$dir/chizzy"
cp "$root"/deploy/nginx/*.conf "$dir/chizzy/"
mv "$dir/chizzy/nginx.conf" "$dir/nginx.conf"
# The probe shares gateway.conf's http context, so it can read its maps.
cat >>"$dir/chizzy/gateway.conf" <<'EOF'

server {
    listen 8081;
    location / {
        default_type text/plain;
        return 200 "$remote_addr $chizzy_client_ip [$chizzy_cf_country]\n";
    }
}
EOF
chmod 755 "$dir" "$dir/chizzy"
chmod 644 "$dir/nginx.conf" "$dir"/chizzy/*.conf

docker run -d --rm --name "$name" \
  -v "$dir/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$dir/chizzy:/etc/nginx/chizzy:ro" \
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
# check <X-Forwarded-For> <CF-Connecting-IP> <CF-IPCountry> <want>
check() {
  xff=$1
  cf_ip=$2
  cf_country=$3
  want=$4
  got=$(docker exec "$name" wget -q -O - \
    --header "X-Forwarded-For: $xff" \
    --header "CF-Connecting-IP: $cf_ip" \
    --header "CF-IPCountry: $cf_country" \
    http://127.0.0.1:8081/)
  if [ "$got" = "$want" ]; then
    echo "ok   X-Forwarded-For '$xff' -> $got"
  else
    echo "FAIL X-Forwarded-For '$xff' -> $got (want $want)" >&2
    failed=1
  fi
}

# Through Cloudflare: the edge the host proxy appended stays $remote_addr, and
# the client and country come from Cloudflare's headers.
check "203.0.113.7, 104.21.61.104" "203.0.113.7" "GB" "104.21.61.104 203.0.113.7 [GB]"
check "203.0.113.7, 172.67.208.243" "203.0.113.7" "US" "172.67.208.243 203.0.113.7 [US]"
check "203.0.113.7, 2606:4700::6810:3d68" "203.0.113.7" "IN" "2606:4700::6810:3d68 203.0.113.7 [IN]"
# A forged X-Forwarded-For entry left of Cloudflare does not matter.
check "1.2.3.4, 198.51.100.9, 104.21.61.104" "198.51.100.9" "IN" "104.21.61.104 198.51.100.9 [IN]"
# Through private hops only: Cloudflare headers are dropped, not believed.
check "203.0.113.7, 10.0.0.5" "1.1.1.1" "IN" "203.0.113.7 203.0.113.7 []"
# Any other public hop is the client; nothing to its left, and no Cloudflare
# header it sent, is believed.
check "203.0.113.7, 198.51.100.9" "1.1.1.1" "IN" "198.51.100.9 198.51.100.9 []"

if [ "$failed" != 0 ]; then exit 1; fi
echo "gateway real client IP checks passed"
