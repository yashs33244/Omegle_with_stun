#!/usr/bin/env sh
# Fails if the response headers the three frontend hosts send drift apart:
#   new-frontend/vercel.json                  Vercel (free-tier mirror)
#   new-frontend/_headers.template            Cloudflare Pages (scripts/write-headers.mjs)
#   new-frontend/nginx-security-headers.conf  the nginx image, plus the per-location
#   new-frontend/nginx.conf                   add_header lines (/assets/, /models/, /admin)
# Each source is normalised to "<scope> <Header-Name>: <value>" lines (scopes
# /*, /assets/*, /models/*, /admin*), whitespace collapsed, and the CSP
# connect-src API origin taken from vercel.json substituted into the two
# templates' ${CSP_CONNECT_SRC}. nginx's Cache-Control "no-cache" lines are
# skipped: Vercel and Pages revalidate by default, nginx has to say so.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
fe="$root/new-frontend"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Scope and value normalisation shared by every source: collapse whitespace,
# strip trailing spaces, sort.
normalise() {
  sed -E 's/[[:space:]]+/ /g; s/ +$//' | sort
}

# vercel.json: the "headers" array. Sources are path-to-regexp patterns;
# "(.*)" is the splat.
# shellcheck disable=SC2016 # the ${} are JavaScript template literals
node -e '
  const { headers } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const rule of headers) {
    const scope = rule.source.replace(/\(\.\*\)/, "*").replace(/^\/\*$/, "/*");
    for (const { key, value } of rule.headers) console.log(`${scope} ${key}: ${value}`);
  }
' "$fe/vercel.json" | normalise > "$tmp/vercel"

# The API origin Vercel allows: the https and wss entries right after 'self'
# in connect-src. The same string is what write-headers.mjs and
# nginx-api-origin.envsh produce from VITE_API_URL.
connect_src=$(sed -nE "s/.*connect-src ('self' https:\/\/[^ ]+ wss:\/\/[^ ]+) .*/\1/p" "$tmp/vercel" | head -n 1)
if [ -z "$connect_src" ]; then
  echo "FAIL vercel.json: connect-src must start with 'self' <https origin> <wss origin>" >&2
  exit 1
fi

# _headers.template: "/scope" lines start a block, indented "Name: value"
# lines belong to it, "#" lines are comments.
awk -v cs="$connect_src" '
  /^#/ || /^[[:space:]]*$/ { next }
  /^[^[:space:]]/ { scope = $0; next }
  { sub(/^[[:space:]]+/, ""); gsub(/\$\{CSP_CONNECT_SRC\}/, cs); print scope " " $0 }
' "$fe/_headers.template" | normalise > "$tmp/pages"

# nginx: security-headers.inc is included by every location, so its headers
# apply to /*. nginx.conf adds Cache-Control and more in /assets/, /models/
# and /admin; "always" and the nginx escaping of quotes are stripped.
nginx_header() {
  sed -nE 's/^[[:space:]]*add_header[[:space:]]+([^[:space:]]+)[[:space:]]+"((\\.|[^"\\])*)"[[:space:]]*(always)?;.*$/\1: \2/p' | sed 's/\\"/"/g'
}
sed "s|\${CSP_CONNECT_SRC}|$connect_src|" "$fe/nginx-security-headers.conf" | nginx_header | sed 's|^|/* |' > "$tmp/nginx"
awk '
  /^[[:space:]]*location / {
    scope = ""
    if ($0 ~ /location \/assets\/ \{/) scope = "/assets/*"
    if ($0 ~ /location \/models\/ \{/) scope = "/models/*"
    if ($0 ~ /location \^~ \/admin \{/) scope = "/admin*"
    next
  }
  /^[[:space:]]*}/ { scope = ""; next }
  scope != "" && /add_header/ && !/Cache-Control "no-cache"/ { print scope "|" $0 }
' "$fe/nginx.conf" | while IFS='|' read -r scope line; do
  printf '%s\n' "$line" | nginx_header | sed "s|^|$scope |"
done >> "$tmp/nginx"
normalise < "$tmp/nginx" > "$tmp/nginx.sorted"

failed=0
for other in pages nginx.sorted; do
  if ! diff -u "$tmp/vercel" "$tmp/$other" > "$tmp/diff"; then
    case $other in
      pages) what="new-frontend/_headers.template (Cloudflare Pages)" ;;
      *) what="new-frontend/nginx-security-headers.conf + nginx.conf" ;;
    esac
    echo "FAIL frontend headers: new-frontend/vercel.json and $what differ (-vercel +other):" >&2
    grep -E '^[-+][^-+]' "$tmp/diff" >&2
    failed=1
  fi
done

if [ "$failed" -eq 0 ]; then
  echo "ok   frontend headers: vercel.json, _headers.template and nginx agree ($(wc -l < "$tmp/vercel" | tr -d ' ') headers, connect-src $connect_src)"
fi
exit "$failed"
