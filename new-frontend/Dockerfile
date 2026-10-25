# syntax=docker/dockerfile:1
# Frontend image: Vite build served by unprivileged nginx on port 8080.
# Build:  docker build --build-arg VITE_API_URL=https://api.example.com -t chizzy-frontend ./new-frontend
# Image tags are literal (not ARGs) so dependabot can bump them.

FROM node:22.23.4-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Socket server origin baked into the bundle.
ARG VITE_API_URL=https://chizzyapi.itsyash.space
# An empty build arg falls back like config.ts does, so the bundle and the CSP agree.
ENV VITE_API_URL=${VITE_API_URL:-https://chizzyapi.itsyash.space}
# Public origin of the site: canonical, og:url and og:image URLs, sitemap.xml
# and robots.txt (vite.config.ts, scripts/prerender-meta.mjs).
ARG VITE_SITE_URL=https://chizzy.itsyash.space
ENV VITE_SITE_URL=${VITE_SITE_URL:-https://chizzy.itsyash.space}
RUN npm run build
# Pre-compressed copies of the moderation models and their runtimes, served by
# gzip_static (nginx.conf, /models/): the 12 MB MediaPipe wasm goes out as
# about 4 MB without nginx compressing it again on every request.
RUN find dist/models -type f \( -name '*.wasm' -o -name '*.js' -o -name '*.json' -o -name '*.bin' -o -name '*.tflite' \) \
    -exec gzip -9 -n -k {} +

FROM nginxinc/nginx-unprivileged:1.28.2-alpine3.23 AS runtime
# The CSP connect-src is derived from this at container start (see
# nginx-api-origin.envsh). Defaults to the URL the bundle was built with.
ARG VITE_API_URL=https://chizzyapi.itsyash.space
ENV API_ORIGIN=${VITE_API_URL:-https://chizzyapi.itsyash.space}
# Worker and file descriptor limits (main context).
COPY nginx-main.conf /etc/nginx/nginx.conf
# The image entrypoint renders /etc/nginx/templates/*.template with envsubst.
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY nginx-security-headers.conf /etc/nginx/templates/security-headers.inc.template
# Empty Cloudflare range list for the limit key in nginx.conf; docker-compose.yml
# mounts deploy/nginx (the real list) over this directory.
COPY nginx-cloudflare-ips.conf /etc/nginx/chizzy/cloudflare-ips.conf
COPY --chmod=755 nginx-api-origin.envsh /docker-entrypoint.d/18-api-origin.envsh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
