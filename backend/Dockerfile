# syntax=docker/dockerfile:1
# Backend image: bun installs and compiles, Node 22 runs dist/.
# Build:  docker build -t chizzy-backend ./backend
# Node is the production runtime because it enforces Socket.IO's
# maxHttpBufferSize on websocket frames (Bun did not; BUGS.md S-03).
# The bun version must read the committed text lockfile (bun.lock). Image tags
# are literal (not ARGs) so dependabot can bump them.

FROM oven/bun:1.4.2-alpine AS base
WORKDIR /app
COPY package.json bun.lock ./
# bun.lock may record tarball URLs from a private package-firewall mirror
# (whatever registry the developer machine used). Point them at the public npm
# registry so the build works on CI and on any host. Integrity hashes do not
# change, so the install is still fully verified. No-op for a clean lockfile.
RUN sed -i -E 's#https://registry\.npmjs\.org/#https://registry.npmjs.org/#g' bun.lock

# All dependencies, used to compile.
FROM base AS build
RUN bun install --frozen-lockfile
# Everything the build script may need (tsconfig*.json, src/); tests and local
# artifacts are excluded by .dockerignore.
COPY . .
RUN bun run build

# Production dependencies only.
FROM base AS prod-deps
RUN bun install --frozen-lockfile --production

FROM node:22.23.3-alpine3.24 AS runtime
ENV NODE_ENV=production \
    PORT=3004
WORKDIR /app
# Files stay owned by root and are only readable by the runtime user.
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3004
STOPSIGNAL SIGTERM
# Alpine has no curl; use Node's fetch against the liveness endpoint.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3004) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Same command as the `start` package script, without npm/bun in between, so
# the server receives SIGTERM directly and can shut down gracefully.
CMD ["node", "dist/index.js"]
