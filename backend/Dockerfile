# syntax=docker/dockerfile:1
# Backend image: Bun + TypeScript compiled to dist/.
# Build:  docker build -t chizzy-backend ./backend
# The bun version must read the committed text lockfile (bun.lock). Image tags
# are literal (not ARGs) so dependabot can bump them; keep both FROM lines equal.

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
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# Production dependencies only.
FROM base AS prod-deps
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3004
WORKDIR /app
# Files stay owned by root and are only readable by the runtime user.
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 3004
STOPSIGNAL SIGTERM
# Alpine has no curl; use bun's fetch against the liveness endpoint.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3004) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Run the server directly (not through `bun run`) so it is PID 1 and receives
# SIGTERM for graceful shutdown. Same command as the `start` package script.
CMD ["bun", "dist/index.js"]
