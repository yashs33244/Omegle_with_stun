# syntax=docker/dockerfile:1
# Frontend image: Vite build served by unprivileged nginx on port 8080.
# Build:  docker build --build-arg VITE_API_URL=https://api.example.com -t chizzy-frontend ./new-frontend
ARG NODE_IMAGE=node:22.23.3-alpine3.24
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28.2-alpine3.23

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Point any private package-firewall mirror URLs in the lockfile at the public
# npm registry so `npm ci` works on CI and any host (integrity is unchanged).
RUN sed -i -E 's#https://registry\.npmjs\.org/#https://registry.npmjs.org/#g' package-lock.json \
 && npm ci --no-audit --no-fund
COPY . .
# Socket server origin baked into the bundle.
ARG VITE_API_URL=https://chizzyapi.itsyash.space
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

FROM ${NGINX_IMAGE} AS runtime
# The CSP connect-src is derived from this at container start (see
# nginx-api-origin.envsh). Defaults to the URL the bundle was built with.
ARG VITE_API_URL=https://chizzyapi.itsyash.space
ENV API_ORIGIN=${VITE_API_URL}
# The image entrypoint renders /etc/nginx/templates/*.template with envsubst.
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY nginx-security-headers.conf /etc/nginx/templates/security-headers.inc.template
COPY --chmod=755 nginx-api-origin.envsh /docker-entrypoint.d/18-api-origin.envsh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
