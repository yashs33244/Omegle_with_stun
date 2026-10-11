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

Production layout:

```
browser -> Cloudflare (proxy, Turnstile; TURN for relayed media)
        -> host proxy on EC2 (TLS) -> frontend :5173 (SPA, /admin, /models)
                                   -> gateway :3004 -> backend replicas -> Redis
```

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

### Required for the launch build

The deploy stops before touching the host when `SESSION_SECRET`,
`ADMIN_TOKEN` or the Turnstile pair is missing (see "First deploy of the
launch build"); the backend itself also refuses to start without them.

| secret | used for |
|---|---|
| `SESSION_SECRET` | HMAC key for session and age tokens (`openssl rand -hex 32`, at least 32 characters) |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | Cloudflare Turnstile widget for the SPA hostname. The secret verifies both the session gate and the takedown form; the site key is public (served by `/api/config`) |
| `ADMIN_TOKEN` | bearer token for `/admin/api/*` (`openssl rand -hex 32`, at least 24 characters) |
| `PSEUDONYM_SALT` | salt for the pseudonymous device ids the admin console shows (`openssl rand -hex 32`). Strongly recommended: without it they are derived from `ADMIN_TOKEN` and all change when the token is rotated. Set it once and never change it; the deploy warns while it is empty |
| `TURN_PROVIDER` | `cloudflare` |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Cloudflare Realtime TURN key; the backend mints per-call credentials with it |
| `TRUST_CLOUDFLARE` | `true` once both hostnames are proxied by Cloudflare (see "Cloudflare in front") |

### Optional

| secret | default | used for |
|---|---|---|
| `SESSION_SECRET_PREVIOUS` | unset | previous `SESSION_SECRET`, still accepted during a rotation; clear it after 180 days |
| `TURNSTILE_DISABLED` | `false` | skips Turnstile (session gate and takedown form). Staging and load tests only, never production |
| `SESSION_RATE_PER_IP_PER_MIN`, `SESSION_RATE_PER_NETWORK_PER_MIN` | `10`, `60` | `POST /api/session` requests per minute per client IP and per /24 (IPv6 /48) network |
| `MATCH_CAP_PER_DEVICE_PER_HOUR`, `MATCH_CAP_PER_IP_PER_HOUR` | `200`, `200` | matches per hour per device and per client IP |
| `CF_ACCOUNT_ID`, `CF_ANALYTICS_TOKEN` | unset | TURN spend poller (read-only Analytics token) |
| `TURN_SPEND_DAILY_GB` | `35,50,70` | daily TURN egress thresholds in GB: lower the relay bitrate, then turn off Hide my IP, then turn off TURN |
| `TURN_CACHE_SECONDS` | `300` | how long a device reuses one set of TURN credentials |
| `TURN_MAX_PER_DEVICE_HOUR`, `TURN_MAX_PER_IP_HOUR` | `20`, `100` | TURN credential sets per hour per device and per client IP |
| `SENTRY_DSN`, `SENTRY_DSN_FRONTEND` | unset | Sentry projects for the backend and the SPA |
| `POSTHOG_KEY`, `POSTHOG_HOST` | unset | PostHog Cloud project (cookieless) |
| `ADMIN_ALLOWED_IPS` | unset | comma list of IPs or CIDRs allowed to call the admin API, on top of the token |
| `EVIDENCE_S3_BUCKET`, `EVIDENCE_S3_REGION` | unset | evidence in S3 instead of the `evidence-data` volume (credentials from the instance role). The region is required with a bucket; the deploy stops without it |
| `EVIDENCE_S3_KMS_KEY_ID` | unset (SSE-S3) | KMS key for SSE-KMS encryption of evidence objects |
| `CLOUDFLARE_ONLY` | `false` | `true`: the gateway refuses requests that did not come through Cloudflare |
| `BACKUP_S3_URI` | unset | `s3://bucket/prefix` for the nightly Redis snapshot (docs/redis-backup.md) |
| `PROJECT_PATH` | `Omegle_with_stun` | directory on the host (relative to the SSH user's home, or absolute) that holds `docker-compose.yml` and `.env` |
| `EC2_SSH_FINGERPRINT` | unset | SHA256 host key fingerprint; when set, the SSH steps refuse a different host key (recommended). Get it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the host |
| `VITE_API_URL` | `REACT_APP_API_URL`, then `https://chizzyapi.itsyash.space` | public URL of the socket server, baked into the frontend build and its CSP |
| `REACT_APP_API_URL` | none | older name of `VITE_API_URL`, still read as a fallback |
| `VITE_SITE_URL` | `https://chizzy.itsyash.space` | public URL of the site, baked into the frontend build: canonical and link preview URLs, `sitemap.xml` and `robots.txt` |
| `CORS_ORIGINS` | `https://chizzy.itsyash.space` | comma list of allowed browser origins (the frontend URL). The backend refuses to start in production without it |
| `BACKEND_REPLICAS` | `2` | number of backend containers |
| `BIND_ADDRESS` | `0.0.0.0` | host address the gateway (3004) and frontend (5173) ports bind to. Set `127.0.0.1` when the host proxy runs on the same host and connects via localhost, so the ports are not reachable around it |
| `BACKEND_PORT`, `FRONTEND_PORT` | `3004`, `5173` | host ports of the gateway and the frontend (the host proxy must point at them) |
| `REDIS_PASSWORD` | unset | optional Redis password, URL safe (`openssl rand -hex 32`) |
| `METRICS_TOKEN` | unset | bearer token for `GET /metrics` on the replicas |
| `LOG_LEVEL` | `info` | pino log level |
| `MAX_CONNECTIONS_PER_IP` | `10` | Socket.IO connections allowed per client IP on each backend replica. Raise it if many users share one address (office NAT, mobile carrier NAT). Needs the real client IP, see [Behind Cloudflare](#cloudflare-in-front) |
| `CONNECT_BURST_PER_IP`, `CONNECT_RATE_PER_IP_PER_SEC` | `20`, `1` | new socket connections per client IP on each replica: a burst, then a steady rate per second. Raise both only for load tests |
| `MATCH_ACCEPT_TIMEOUT_MS` | `30000` | how long both users have to accept a match |
| `SHUTDOWN_GRACE_MS` | `10000` | how long a replica drains on stop; keep it under the 15 s `stop_grace_period` in `docker-compose.yml` |
| `STUN_URLS` | Google public STUN | comma list |
| `TURN_URLS`, `TURN_SECRET`, `TURN_USERNAME`, `TURN_CREDENTIAL`, `TURN_TTL_SECONDS` | unset | self-hosted TURN on a separate host only (`TURN_PROVIDER` `static` or `secret`) |

Repository **variable** (not a secret) and the canary secret:

| name | kind | used for |
|---|---|---|
| `CANARY_URL` | variable | API origin the canary tests every 15 minutes; unset disables the canary |
| `CANARY_TURNSTILE_BYPASS` | secret, optional | token the canary sends instead of Cloudflare's dummy test token (see "Synthetic canary") |

Secrets nothing reads any more and that can be deleted: `JWT_SECRET`,
`FRONTEND_URL`, `DB_URL`, `REDIS_URL` (Redis is part of the stack),
`AWS_REGION` (now `EVIDENCE_S3_REGION`), `TURNSTILE_SECRET_KEY` (now
`TURNSTILE_SECRET`), and the coturn settings `RUN_COTURN`, `TURN_REALM`, `TURN_EXTERNAL_IP` (coturn was
removed from the stack; the next deploy removes a running coturn container
as an orphan).

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
    minutes, and `X-Forwarded-Proto` set. It must **append** the address it
    received the connection from to `X-Forwarded-For` (nginx:
    `$proxy_add_x_forwarded_for`; Caddy does this by default). The gateway
    uses that last hop to tell Cloudflare from everyone else.
- Security group: 443 (and 80) open to Cloudflare's ranges only once
  Cloudflare is in front (to the world before that), 22 to where you deploy
  from (or use SSM). Ports 3004 and 5173 do not need to be public (set
  `BIND_ADDRESS=127.0.0.1`). No TURN ports: TURN is Cloudflare's.
- For backups: the AWS CLI on the host, and an instance role with
  `s3:PutObject` on the backup prefix (docs/redis-backup.md). For S3
  evidence: the role also needs access to `EVIDENCE_S3_BUCKET`, and the
  instance metadata hop limit must be 2 so containers can reach the role
  credentials (`aws ec2 modify-instance-metadata-options --http-put-response-hop-limit 2 ...`).

The gateway trusts `X-Forwarded-For` only from private addresses (the host
proxy and Docker's port publishing), so the backend sees the real client IP for
its per-IP limits, and a client connecting directly cannot spoof it. Behind
Cloudflare the real client IP comes from `CF-Connecting-IP`, which the gateway
believes only when the previous hop is a Cloudflare address.
`sh scripts/test-gateway-real-ip.sh` checks which client address and country
the gateway passes on for each kind of forwarding chain (CI runs it). If many
real users share one address (office or carrier NAT), raise
`MAX_CONNECTIONS_PER_IP`.

## Cloudflare in front

Both hostnames go through Cloudflare (proxied DNS records, SSL mode "Full
(strict)" with a Cloudflare Origin CA certificate on the host proxy).
Websockets work through Cloudflare on every plan; Socket.IO's 20 s ping keeps
idle sockets open, and the client reconnects and re-sends hello when
Cloudflare restarts an edge.

**Why geo-blocking needs this.** The country blocklist (`blocked_countries`
flag: the UK, EU and EEA, and Australia by default) reads Cloudflare's
`CF-IPCountry` header. A header is only as trustworthy as the path it came
on: if the origin also accepts direct connections, anyone can send their own
`CF-IPCountry: US` and skip the block (Ofcom has fined a service for blocking
UK users badly). So:

1. Proxy both the SPA and the API hostname through Cloudflare.
2. Set `TRUST_CLOUDFLARE=true` so the backend uses the country header. With
   it false the country is unknown and the blocklist cannot apply.
3. The gateway forwards `CF-IPCountry` and `CF-Connecting-IP` only for
   requests whose previous hop is in Cloudflare's published ranges
   (`deploy/nginx/cloudflare-ips.conf`); from anywhere else it drops them.
4. Lock the origin to Cloudflare, in two layers:
   - the security group allows 443 only from https://www.cloudflare.com/ips-v4
     and https://www.cloudflare.com/ips-v6 (the strongest layer);
   - `CLOUDFLARE_ONLY=true`: every deploy runs `deploy/cloudflare-ips.sh`,
     which refreshes the ranges and writes a gateway rule that answers 403 to
     any public address that is not Cloudflare. Health checks from the host
     and the compose network still pass.

`deploy/cloudflare-ips.sh` keeps the existing list if the download fails or
looks wrong, so a failed download never empties the list. A snapshot of the
ranges is committed; refresh it with `sh deploy/cloudflare-ips.sh` and commit
when Cloudflare announces changes. Test the block from UK, US and EU exits (a
commercial VPN and a cloud VM) before launch and record the result in
docs/risk-assessment.md.

Also on Cloudflare: Turnstile (the site key and secret above), Realtime TURN
(the key above, plus a billing notification), and **Cloudflare Access** in
front of `chizzyapi.itsyash.space/admin/api/*` and `chizzy.itsyash.space/admin`
(free for small teams), so the admin console is not on the open internet even
though it also needs `ADMIN_TOKEN`.

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
first run, so that deploy cannot roll back automatically. It does save the old
`docker-compose.yml` in `.previous/`. If the first deploy fails, put the old
setup back by hand (its `yashs3324/omegle-*:latest` images are still on the
host, and the old compose file needs nothing from `.env`):

```sh
cd ~/Omegle_with_stun
cp .previous/docker-compose.yml .      # or restore it from the old git checkout
docker compose up -d --remove-orphans
```

Then fix the problem and deploy again; the next deploy installs the new files
as usual. Never re-run a Deploy workflow run from before this setup (one
without the "Deploy, verify and roll back on failure" step): its old script
rewrites `.env` without the image names, runs `docker compose down` on the
whole new stack including Redis, and prunes the sha-tagged images rollback
needs.

That first deploy also changes the socket protocol. Tabs still open on the old
site keep sending the old events, which the new server ignores, so those users
stay on "searching" until they reload the page. Deploy at a quiet time. From
the second deploy on, the new client reconnects and re-queues by itself.

## First deploy of the launch build

The launch build (session gate, admin console, evidence store, on-device
moderation) needs new secrets and a few Cloudflare settings. In order:

1. **Secrets** (GitHub -> Settings -> Secrets -> Actions):
   - `SESSION_SECRET`, `ADMIN_TOKEN`, `PSEUDONYM_SALT`: three different values
     from `openssl rand -hex 32`. Keep a copy of `PSEUDONYM_SALT` offline; it
     must never change.
   - `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` from a Turnstile widget whose
     hostname list has the SPA hostname (`chizzy.itsyash.space`).
   - `TURN_PROVIDER=cloudflare`, `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`.
   - Check `CORS_ORIGINS` and `VITE_API_URL` name the real hostnames.
   - Optional now, needed before launch: `SENTRY_DSN`, `SENTRY_DSN_FRONTEND`,
     `POSTHOG_KEY`, `POSTHOG_HOST`, `CF_ACCOUNT_ID` and `CF_ANALYTICS_TOKEN`.
2. **Evidence volume.** Nothing to create: the first `docker compose up`
   makes the `evidence-data` volume, owned by the backend's `node` user. Check
   the disk has room (`df -h /var/lib/docker`), never run
   `docker volume prune`, and note that `scripts/backup-redis.sh` does not
   copy this volume (docs/redis-backup.md). To use S3 instead, set
   `EVIDENCE_S3_BUCKET` and `EVIDENCE_S3_REGION` (plus `EVIDENCE_S3_KMS_KEY_ID`
   for SSE-KMS), give the instance role read, write and delete on the bucket
   (and the KMS key), and set the metadata hop limit to 2 (Host
   prerequisites).
3. **Cloudflare** (see "Cloudflare in front"): both hostnames proxied, SSL
   "Full (strict)", an Access application on `/admin/api/*` and `/admin`, and
   a Cache Rule that makes `chizzy.itsyash.space/models/*` eligible for cache
   (Cloudflare does not cache `.wasm` by default; the origin already sends a
   one-year immutable `Cache-Control`). After the deploy works through
   Cloudflare: `TRUST_CLOUDFLARE=true`, then the security group, then
   `CLOUDFLARE_ONLY=true` (in that order; `CLOUDFLARE_ONLY` before the DNS is
   proxied answers 403 to everyone).
4. **Deploy** (push to `new-v`) at a quiet time, then check:
   `https://chizzyapi.itsyash.space/api/config` shows a `turnstileSiteKey`;
   the SPA shows the date of birth gate and passes it; `/admin` accepts
   `ADMIN_TOKEN` and shows the queue; one test report reaches the queue with
   its evidence.

What happens when a secret is missing:

| missing | result |
|---|---|
| `SESSION_SECRET`, `ADMIN_TOKEN`, `CORS_ORIGINS`, or `TURNSTILE_SECRET` / `TURNSTILE_SITE_KEY` (with `TURNSTILE_DISABLED` not `true`) | the deploy stops with "missing or too short: ..." before changing anything on the host; the running version keeps serving. If the value only goes missing in a hand-edited `.env`, the backend refuses to start, the health check fails and the deploy rolls back to the previous tag |
| `EVIDENCE_S3_REGION` while `EVIDENCE_S3_BUCKET` is set | the deploy stops the same way |
| `PSEUDONYM_SALT` | the deploy warns and continues; admin pseudonyms are derived from `ADMIN_TOKEN` and all change when it is rotated |
| `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` with `TURN_PROVIDER=cloudflare` | the backend refuses to start and the deploy rolls back |
| `TURN_PROVIDER` | no relay: users behind strict NATs cannot connect, and Hide my IP cannot work |
| `TRUST_CLOUDFLARE` | the country is unknown, so the `blocked_countries` blocklist does not apply |
| `CF_ACCOUNT_ID` / `CF_ANALYTICS_TOKEN` | no TURN spend poller: nothing steps relay use down automatically; rely on the Cloudflare billing alert |
| Sentry or PostHog keys | no error reports or product analytics; nothing else changes |

## What a deploy does on the host

`deploy/deploy.sh <sha>` runs in `PROJECT_PATH`:

0. Checks the secrets a production backend needs (see "First deploy of the
   launch build") and stops, naming them, if any is missing.
1. Moves the copied `.incoming/docker-compose.yml` and `.incoming/deploy/` into
   place, keeping the current ones in `.previous/` (when they belong to the
   verified tag, or on the first deploy when there is no saved copy yet).
2. Writes `.env` (mode 600) from the secrets without printing it, and sets
   `IMAGE_TAG=<sha>`.
3. `docker compose pull`. If any image is missing it restores the previous
   files and stops; nothing running is touched.
4. `docker compose up -d --no-build --remove-orphans --wait`, which waits for
   every container healthcheck (Redis ping, backend `/healthz`, gateway,
   frontend `/healthz`).
   Before that, `deploy/cloudflare-ips.sh` refreshes the gateway's Cloudflare
   files (and the origin lock when `CLOUDFLARE_ONLY=true`), and a checksum of
   `deploy/nginx/` recreates the gateway when any of its config changed.
5. Verifies through the published ports, with retries: gateway `/healthz`,
   gateway `/readyz` (backend can reach Redis) and frontend `/healthz`.
6. On success records the sha in `.deployed-tag` and prunes dangling images only.
7. On failure prints `docker compose ps` and recent logs, restores `.previous/`,
   starts the previous tag from `.deployed-tag`, verifies it, and fails the job
   either way so the broken commit is visible.

Volumes are never pruned: the `redis-data` volume holds flags, sessions,
restrictions, reports metadata, appeals, takedowns, the audit log, coins and
friends; the `evidence-data` volume holds report evidence (when S3 is not
used), shared by the replicas on this host. The deploy also copies
`scripts/backup-redis.sh` and `scripts/restore-redis.sh` to the host.

A deploy recreates the backend replicas, which drops live calls; clients
reconnect and are re-queued automatically.

## Rollback by hand

Every deployed image is tagged with its commit sha. On the host:

```sh
cd ~/Omegle_with_stun
cat .deployed-tag                       # currently verified tag
bash deploy/deploy.sh <older-sha>       # keeps .env secrets, only changes IMAGE_TAG
```

This keeps the current `docker-compose.yml` and `deploy/`, so it only works
when the older sha used the same compose file and gateway config. To roll back
across a change to either, re-run that commit's successful Deploy workflow run
in GitHub Actions instead: it copies that commit's files and deploys its
images. Only re-run runs made with this setup (they have the "Deploy, verify
and roll back on failure" step). Never re-run a run from before it; see
First-time setup.

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
docker compose up -d                           # re-apply after editing .env by hand (lost on the next deploy; set a secret)
bash scripts/backup-redis.sh                   # Redis snapshot (and S3 upload when BACKUP_S3_URI is set)
```

Every workflow deploy rewrites `.env` from the GitHub secrets, so a hand edit
only lasts until the next push to `new-v`. To change a setting for good, set
its secret.

Container logs rotate at 10 MB x 3 files per container. Backend logs are JSON
(pino) and never contain names, photos or chat text. CERT-In requires 180 days
of logs kept in India; shipping logs to an India-region store is **not set up
yet** (docs/launch-checklist.md).

### Kill switch, flags and staffed hours

Operator flags are edited in the admin console (`/admin` -> Flags) and reach
every replica within about 2 s; no deploy or restart is needed:

| flag | effect |
|---|---|
| `matching_enabled` | off: nobody is matched (live peer-to-peer calls continue) |
| `new_sessions_enabled` | off: `POST /api/session` refuses new sessions |
| `staffed_hours` | e.g. `20:00-24:00 Asia/Kolkata`: matching opens only in that window; empty is always open |
| `banner_message` | banner in the app |
| `default_mode` | `instant` or `preview` |
| `max_waiting` | back-pressure on the queue |
| `turn_enabled`, `private_mode_enabled`, `video_max_kbps`, `relay_video_max_kbps` | relay cost controls (the TURN spend poller also changes them) |
| `blocked_countries` | country blocklist (comma separated ISO codes) |
| `online_count_threshold` | show the real online count only above this |

What to change when is in the runbooks: docs/runbooks/abuse-wave.md,
docs/runbooks/turn-cost-spike.md, docs/runbooks/host-down.md.

### Synthetic canary

`.github/workflows/canary.yml` runs every 15 minutes once the repository
variable `CANARY_URL` is set: two headless clients create sessions, connect
and must both reach `call:start` within 30 s. They use the language code
`zxx` and filter on it, so the server's hard language filter only pairs them
with each other, never with a real person. When matching is closed (staffed
hours or the kill switch) the run passes with "skipped". A failed run is the
alert (GitHub emails whoever last changed the workflow's schedule; Better
Stack can watch the run status).

Turnstile is the catch: the canary cannot solve a real challenge. Either
point `CANARY_URL` at a staging stack that runs with the Turnstile **test**
secret `1x0000000000000000000000000000000AA` (the canary's dummy token passes
there), or, if the backend gains a canary bypass, put its token in the
`CANARY_TURNSTILE_BYPASS` secret. The backend has no such bypass today.

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
docker build --build-arg VITE_API_URL=https://chizzyapi.itsyash.space --build-arg VITE_SITE_URL=https://chizzy.itsyash.space -t yashs3324/omegle-frontend:test ./new-frontend
```

The backend image installs and compiles with bun and runs on `node:22-alpine`
as the `node` user, with `/data/evidence` owned by that user (the evidence
volume mounts there). The frontend image builds with Node 22 and serves `dist/`
from `nginxinc/nginx-unprivileged` on port 8080 with a CSP that allows only
the site itself, the API origin, Cloudflare Turnstile, Sentry ingest and
PostHog, plus `wasm-unsafe-eval` and blob: workers for the on-device models
(self-hosted under `/models/`, cached as immutable: a new model version must
use a new path). `Permissions-Policy` limits camera and microphone to the site
itself. `/admin` is served as the SPA with `X-Robots-Tag: noindex`.

## Load testing

See docs/capacity.md. Never point the load test at production.
