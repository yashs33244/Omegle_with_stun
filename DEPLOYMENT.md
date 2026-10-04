# Deployment

Production runs on one EC2 host with Docker Compose. A push to `new-v` builds,
tests and deploys automatically; there is no manual step after the first-time
setup below.

```
push to new-v
  -> CI (ci.yml via workflow_call): protocol check, backend, frontend, docker builds
  -> images: build and push yashs3324/omegle-backend and yashs3324/omegle-frontend
             tagged <commit sha> and latest
  -> deploy: copy docker-compose.yml and deploy/ to the host, run deploy/deploy.sh <sha>
             (write .env, pull, up --wait, verify health, roll back on failure)
```

Deploys are serialized (`concurrency: deploy-production`, a newer push waits
for the running deploy). `workflow_dispatch` re-runs a deploy by hand.

## GitHub secrets

Settings -> Secrets and variables -> Actions. Values are never printed by the
workflow. Empty optional secrets fall back to the defaults shown.

### Required (already configured)

| secret | used for |
|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub login for pushing images |
| `DOCKERHUB_TOKEN` | Docker Hub access token (read and write) |
| `EC2_HOST` | public hostname or IP of the host |
| `EC2_USER` | SSH user (for example `ubuntu`) |
| `EC2_SSH_KEY` | private key for that user (the full PEM, including the BEGIN and END lines) |

### Optional

| secret | default | used for |
|---|---|---|
| `PROJECT_PATH` | `Omegle_with_stun` | directory on the host (relative to the SSH user's home, or absolute) that holds `docker-compose.yml` and `.env` |
| `EC2_SSH_FINGERPRINT` | unset | SHA256 host key fingerprint; when set, the SSH steps refuse a different host key (recommended). Get it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the host |
| `VITE_API_URL` | `REACT_APP_API_URL`, then `https://chizzyapi.itsyash.space` | public URL of the socket server, baked into the frontend build and its CSP |
| `REACT_APP_API_URL` | none | older name of `VITE_API_URL`, still read as a fallback |
| `CORS_ORIGINS` | `https://chizzy.itsyash.space` | comma list of allowed browser origins (the frontend URL). The backend refuses to start in production without it |
| `BACKEND_REPLICAS` | `2` | number of backend containers |
| `BIND_ADDRESS` | `0.0.0.0` | host address the gateway (3004) and frontend (5173) ports bind to. Set `127.0.0.1` when the host proxy runs on the same host and connects via localhost, so the ports are not reachable around it |
| `REDIS_PASSWORD` | unset | optional Redis password, URL safe (`openssl rand -hex 32`) |
| `METRICS_TOKEN` | unset | bearer token for `GET /metrics` on the replicas |
| `LOG_LEVEL` | `info` | pino log level |
| `STUN_URLS` | Google public STUN | comma list |
| `TURN_URLS` | unset | comma list of TURN URLs handed to clients |
| `TURN_SECRET` | unset | shared secret with coturn (`use-auth-secret`); the backend issues short-lived credentials |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | unset | static TURN credentials instead of `TURN_SECRET` (both or neither) |
| `TURN_TTL_SECONDS` | `43200` | lifetime of issued TURN credentials |
| `RUN_COTURN` | unset | `true` runs the bundled coturn service (compose profile `turn`) on the host |
| `TURN_REALM` | `chizzy` | coturn realm |
| `TURN_EXTERNAL_IP` | unset | for coturn on EC2: `<public-ip>/<private-ip>` |

Secrets from the old setup that nothing reads any more and can be deleted:
`JWT_SECRET`, `FRONTEND_URL`, `DB_URL`, `REDIS_URL` (Redis is part of the stack).

Also recommended: protect `new-v` (require the CI checks and a review) and add
reviewers to the `production` environment if deploys should need approval.

## Host prerequisites

- Linux with Docker Engine 24+ and the Docker Compose v2 plugin (`docker compose version`).
- `curl` and `bash`.
- The SSH user can run `docker` without sudo (`sudo usermod -aG docker $USER`, then log in again).
- A reverse proxy on the host terminates TLS and forwards:
  - `chizzy.itsyash.space` -> `http://127.0.0.1:5173`
  - `chizzyapi.itsyash.space` -> `http://127.0.0.1:3004`, with websocket upgrade
    (`Upgrade` and `Connection` headers), a read timeout of at least a few
    minutes, and `X-Forwarded-For` / `X-Forwarded-Proto` set.
- Security group: 80 and 443 open to the world, 22 to where you deploy from.
  Ports 3004 and 5173 do not need to be public (set `BIND_ADDRESS=127.0.0.1`).
  For coturn: 3478 tcp+udp and 49160-49200 udp.

The gateway trusts `X-Forwarded-For` only from private addresses (the host
proxy and Docker's port publishing), so the backend sees the real client IP for
its per-IP limits, and a client connecting directly cannot spoof it.

## First-time setup

1. Install the prerequisites above and create the project directory
   (`mkdir -p ~/Omegle_with_stun`, or whatever `PROJECT_PATH` says). An old git
   checkout there is fine; the deploy only writes `docker-compose.yml`,
   `deploy/`, `.env` and its state files.
2. Add the secrets. At minimum check `CORS_ORIGINS` and `VITE_API_URL` match
   the real domains.
3. Push to `new-v` (or run the Deploy workflow by hand).

Migrating from the old two-container setup needs nothing special: the compose
project name is still the directory name, so the first deploy replaces the old
`backend` and `frontend` containers. There is no previous verified tag on the
first run, so that deploy cannot roll back automatically.

## What a deploy does on the host

`deploy/deploy.sh <sha>` runs in `PROJECT_PATH`:

1. Moves the copied `.incoming/docker-compose.yml` and `.incoming/deploy/` into
   place, keeping the current ones in `.previous/`.
2. Writes `.env` (mode 600) from the secrets without printing it, and sets
   `IMAGE_TAG=<sha>`.
3. `docker compose pull`. If any image is missing it restores the previous
   files and stops; nothing running is touched.
4. `docker compose up -d --no-build --remove-orphans --wait`, which waits for
   every container healthcheck (Redis ping, backend `/healthz`, gateway,
   frontend `/healthz`).
5. Verifies through the published ports, with retries: gateway `/healthz`,
   gateway `/readyz` (backend can reach Redis) and frontend `/healthz`.
6. On success records the sha in `.deployed-tag` and prunes dangling images only.
7. On failure prints `docker compose ps` and recent logs, restores `.previous/`,
   starts the previous tag from `.deployed-tag`, verifies it, and fails the job
   either way so the broken commit is visible.

Volumes are never pruned: the `redis-data` volume holds coins, friends, bans
and reports.

A deploy recreates the backend replicas, which drops live calls; clients
reconnect and are re-queued automatically.

## Rollback by hand

Every deployed image is tagged with its commit sha. On the host:

```sh
cd ~/Omegle_with_stun
cat .deployed-tag                       # currently verified tag
bash deploy/deploy.sh <older-sha>       # keeps .env secrets, only changes IMAGE_TAG
```

Or re-run an older successful Deploy workflow run in GitHub Actions.

## Health checks

| endpoint | meaning |
|---|---|
| `https://chizzyapi.itsyash.space/healthz` (also `/health`) | a backend replica is alive (through the gateway) |
| `https://chizzyapi.itsyash.space/readyz` | a backend replica can reach Redis (503 if not) |
| `https://chizzy.itsyash.space/healthz` | the frontend nginx is up |
| `http://127.0.0.1:3004/gateway-healthz` | the gateway itself (does not touch the backend) |

`/metrics` is not served through the gateway. To scrape a replica:
`docker compose exec backend wget -qO- --header "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3004/metrics`
(or run Prometheus on the compose network).

## Logs and operations

```sh
cd ~/Omegle_with_stun
docker compose ps
docker compose logs -f --tail=100 backend      # all replicas
docker compose logs -f gateway frontend redis
docker compose up -d                           # re-apply after editing .env by hand
docker compose --profile turn up -d            # start coturn manually
```

Container logs rotate at 10 MB x 3 files per container. Backend logs are JSON
(pino) and never contain names, photos or chat text.

Old sha-tagged images are not deleted automatically (only dangling ones are),
so the previous release stays available for rollback. To reclaim disk space
keep the current and previous tags and remove older ones, for example:

```sh
docker images yashs3324/omegle-backend
docker rmi yashs3324/omegle-backend:<old-sha> yashs3324/omegle-frontend:<old-sha>
```

## Building images by hand

```sh
docker build -t yashs3324/omegle-backend:test ./backend
docker build --build-arg VITE_API_URL=https://chizzyapi.itsyash.space -t yashs3324/omegle-frontend:test ./new-frontend
```

The backend image installs and compiles with bun and runs on `node:22-alpine`
as the `node` user. The frontend image builds with Node 22 and serves `dist/`
from `nginxinc/nginx-unprivileged` on port 8080 with a strict CSP and
`Permissions-Policy` limiting camera and microphone to the site itself.
