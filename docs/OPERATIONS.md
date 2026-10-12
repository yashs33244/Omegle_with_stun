# Operations

How Chizzy is run today: one founder, free tiers, no on-call rota. This page
is the map; the exact commands for a bad day are in the runbooks
([rollback](runbooks/rollback.md), [release](runbooks/release.md),
[host down](runbooks/host-down.md), [abuse wave](runbooks/abuse-wave.md),
[TURN cost spike](runbooks/turn-cost-spike.md)). Base: branch `main`.

## Environments

| environment | frontend | backend | how it gets there |
|---|---|---|---|
| local | `bun run dev` in `new-frontend/` (Vite, :5173) | `bun run dev` in `backend/` (:3004, memory store) | README "Quick start" |
| PR preview | Vercel preview deployment per branch (`<branch>-chizzy-chat.vercel.app`) | none: previews talk to the production Render backend (`VITE_API_URL`) | Vercel Git integration builds every pushed branch |
| production | https://chizzy-chat.vercel.app (Vercel project `chizzy-chat`, Hobby plan, pre-payments mirror) | https://chizzy-api.onrender.com (Render Free web service `srv-db5nnass728c738ek0o0`, region singapore, `render.yaml`) | merge to `main` |
| production (Pages) | https://chizzy.pages.dev (Cloudflare Pages project `chizzy`) | same Render backend | `pages.yml` on push to `main`, only while repo variable `PAGES_ENABLED=true` |
| production (EC2 compose) | nginx :5173 | gateway + replicas + Redis | **paused**: the host is gone; `deploy.yml` runs only by `workflow_dispatch` or with `EC2_DEPLOY_ENABLED=true` (DEPLOYMENT.md) |

The production branch is `main`. Vercel and Render both auto-deploy it on
every push; a merged PR is therefore live within about two minutes (Vercel)
and three to five minutes (Render Docker build). Nothing is deployed from
tags; tags are for releases ([release runbook](runbooks/release.md)).

PR previews run against the live backend. Do not use a preview to test
anything that creates reports, bans or purchases.

## Who deploys what

Automatic on merge to `main`:

- Vercel builds `new-frontend/` with `npm run build` (`new-frontend/vercel.json`),
  environment variables `VITE_API_URL` and `VITE_SITE_URL` from the project settings.
- Render builds `backend/Dockerfile` and replaces the single instance once
  `/healthz` answers (`healthCheckPath` in `render.yaml`, zero-downtime swap
  on Render's side; in-memory state is lost, see Backups).

By hand (same result, used when the Git integration is off or a rebuild is
needed without a commit):

```sh
# frontend: production deploy from the working tree
cd new-frontend && vercel deploy --prod

# backend: redeploy HEAD of main, or a specific commit, and wait for the result
render deploys create srv-db5nnass728c738ek0o0 --wait
render deploys create srv-db5nnass728c738ek0o0 --commit <sha> --wait
```

`render` is the Render CLI (`brew install render`, `render login`); the same
call over the API is `POST https://api.render.com/v1/services/srv-db5nnass728c738ek0o0/deploys`
with a bearer API key. Rolling back is the same command with the previous
commit; see [runbooks/rollback.md](runbooks/rollback.md).

## Health checks

| check | URL | meaning |
|---|---|---|
| liveness | `https://chizzy-api.onrender.com/healthz` (also `/health`) | the process answers |
| readiness | `https://chizzy-api.onrender.com/readyz` | the store answers (503 after the timeout; always 200 on the memory store) |
| client config | `https://chizzy-api.onrender.com/api/config` | `matchingOpen`, `tosVersion`, banner; what the SPA reads on load |
| frontend | `https://chizzy-chat.vercel.app/` | 200 with the SPA shell |

Render polls `/healthz` itself (`healthCheckPath`) and will not switch to a
new deploy that fails it. `backend/src/http/app.ts` serves all three routes.

## Keep-alive and canary

Render Free spins the service down after 15 minutes without inbound traffic
and needs about a minute to wake. Two things keep it warm:

- the backend GETs `KEEPALIVE_URL` (default `$RENDER_EXTERNAL_URL/healthz`)
  every 10 minutes (`backend/src/keepalive.ts`);
- `.github/workflows/keepalive.yml` curls the repository variable
  `KEEPALIVE_URL` (`https://chizzy-api.onrender.com/healthz`) every 10 minutes,
  which also wakes a service that already fell asleep.

The canary (`.github/workflows/canary.yml`, `scripts/loadtest/canary.ts`)
runs every 15 minutes against the repository variable `CANARY_URL`
(`https://chizzy-api.onrender.com`): two headless socket clients create a
session, match each other (language `zxx`, never a real person) and must both
reach `call:start` within 30 s. A run that fails is the alert. "skipped" is a
pass: matching was closed by staffed hours or the kill switch.

Turnstile: the canary sends Cloudflare's dummy token
`XXXX.DUMMY.TOKEN.XXXX`. The backend only checks the token when it has a
Turnstile secret (`SessionService.ts`, `if (deps.turnstileSecret)`), and
`TURNSTILE_DISABLED=true` sets that secret to `undefined` (`config.ts`). So
the dummy token is accepted **only while `TURNSTILE_DISABLED=true`** on
Render. The day real Turnstile keys go in, the canary will fail on every run
until either `CANARY_URL` points at a staging stack running the Turnstile
test secret or the backend gains a bypass whose token goes in the
`CANARY_TURNSTILE_BYPASS` secret (DEPLOYMENT.md "Synthetic canary"). Plan
that switch together with the key rollout.

## Metrics

`GET /metrics` serves Prometheus text when the request carries
`Authorization: Bearer $METRICS_TOKEN`; `METRICS_TOKEN` is set on the Render
service (Environment tab). Scrape by hand:

```sh
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" https://chizzy-api.onrender.com/metrics
```

Useful series (`backend/src/match/matchMetrics.ts`, `backend/src/metrics.ts`):
`chizzy_calls_total{outcome,local_candidate,private}`,
`chizzy_time_to_connect_seconds` (histogram, call:start to connected),
`chizzy_call_failed_total{reason}`, `chizzy_moderation_signals_total{kind}`,
`chizzy_chat_redacted_total`. There is no Prometheus server; a free Grafana
Cloud stack with a remote scrape, or the curl above from cron, is the next
step when numbers matter. Counters reset on every deploy or spin-down.

## Logs

```sh
render logs -r srv-db5nnass728c738ek0o0 --tail                  # stream
render logs -r srv-db5nnass728c738ek0o0 --level error --limit 200
render logs -r srv-db5nnass728c738ek0o0 --text "BILLING DISABLED"
vercel logs chizzy-chat.vercel.app --follow                     # frontend request logs (static, mostly 200s)
```

Backend logs are JSON (pino, `LOG_LEVEL=info`) and never contain names,
photos or chat text. Render keeps Free-tier logs for 7 days; shipping them to
an India-region store for CERT-In's 180-day rule is **not set up**
([launch-checklist.md](launch-checklist.md)).

## Alerts

What exists today:

- GitHub emails the person who last touched a scheduled workflow when
  `canary.yml` or `keepalive.yml` fails (Settings -> Notifications -> Actions
  must have "Failed workflows only" on).
- Render emails the workspace owner when a deploy fails (`notifyOnFail: default`).
- Vercel emails on a failed production build.

Placeholder, not configured: a Better Stack (free plan) monitor on
`https://chizzy-api.onrender.com/healthz` every 3 minutes with a phone push,
plus a status page. Until then the canary run list
(`gh run list --workflow=canary.yml`) is the uptime history.

## Secrets inventory

Names only. Values live where the table says and nowhere in the repository.

| secret | where | rotation |
|---|---|---|
| `SESSION_SECRET`, `ADMIN_TOKEN`, `PSEUDONYM_SALT` | Render env (generated by the blueprint) | rotate `SESSION_SECRET` by moving the old value to `SESSION_SECRET_PREVIOUS` for one token lifetime, then clearing it; rotating `ADMIN_TOKEN` logs every admin out; never rotate `PSEUDONYM_SALT` (admin pseudonyms would change) |
| `METRICS_TOKEN` | Render env | rotate freely; update the scraper |
| `TURNSTILE_SECRET` / `TURNSTILE_SITE_KEY` | not set (`TURNSTILE_DISABLED=true`) | when added, also fix the canary (above) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Render env, `sync: false` | all three together; needs `REDIS_URL` first (README "Coin packs need a durable store") |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Render env when `TURN_PROVIDER=cloudflare` | rotate in the Cloudflare dashboard, then Render |
| `SENTRY_DSN`, `POSTHOG_KEY` | Render env (optional) | public-ish; rotate on leak |
| `REDIS_URL` | not set (memory store) | Upstash dashboard when added |
| `VITE_API_URL`, `VITE_SITE_URL` | Vercel project env (not secret) | change = redeploy |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secrets (Pages path) | Cloudflare dashboard |
| `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` | GitHub Actions secrets (image builds) | Docker Hub |
| `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`, `PROJECT_PATH` | GitHub Actions secrets | stale (host gone); delete when the EC2 path is retired |
| `CANARY_TURNSTILE_BYPASS` | GitHub Actions secret, unset | only with a backend bypass |
| repo variables `CANARY_URL`, `KEEPALIVE_URL`, `PAGES_ENABLED`, `BACKEND_IMAGE`, `FRONTEND_IMAGE` | GitHub Actions variables | not secret |

Render's API key and the Vercel token live in each founder's own CLI login
(`render login`, `vercel login`), not in CI.

## Admin API

On Render there is no Cloudflare Access in front of `/admin/api` and
`ADMIN_ALLOWED_IPS` is unset, so the backend logs `ADMIN API WARNING:
ADMIN_ALLOWED_IPS is empty` at every start. The API is then guarded by
`ADMIN_TOKEN` and two in-memory failure limits (`backend/src/http/constants.ts`,
reset by a restart or deploy):

| limit | value | answer |
|---|---|---|
| bad tokens per IP | 10 per 15 min from that IP's first failure | 429 for that IP, right token included |
| bad tokens across all IPs | 100 per hour from the first failure | 429 with `Retry-After` for every admin request, right token included; logged once at error, `event: "admin_auth_budget_exhausted"` |

When the console answers 429 and you did not mistype the token yourself:

1. `render logs -r srv-db5nnass728c738ek0o0 --tail` and look for
   `admin_auth_budget_exhausted` (someone is guessing from many IPs) or
   repeated `admin_auth_failed`.
2. Either wait for `Retry-After`, or lock the API to yourself: set
   `ADMIN_ALLOWED_IPS` in the Render env to your address or block (CIDR is
   accepted, e.g. `203.0.113.0/24` or `2001:db8:1::/48`); saving the env
   restarts the service, which also clears the counters.
3. If the token may have leaked (successful requests you did not make in the
   audit log), rotate `ADMIN_TOKEN` (Secrets inventory above).

## Session gate limits worth knowing on a bad day

- A socket is disconnected when its 24 h session token expires: the client
  gets `server:error` `session_expired` and mints a new session. A wave of
  reconnects exactly 24 h after a busy hour is this, not an outage.
- A ban (24 h or longer, set in `/admin`) also refuses new sessions from the
  address the banned device last used (IPv4 address or IPv6 /64) for 6 h.
  Users behind the same carrier NAT who already hold a session are not
  affected; new ones on that address see the restriction page without an
  appeal button for those hours. Lifting the ban lifts this at once.
- At most `SESSION_NEW_DEVICES_PER_NETWORK_PER_DAY` (50) new device ids per
  address per UTC day get a session (429 `rate_limited` beyond). If
  `chizzy_session_requests_total{result="rate_limited"}` climbs without an
  attack (a campus or carrier NAT), raise it in the Render env.

## Backups

There is nothing to back up on the current production: the Render service
runs the in-memory store, so sessions, bans, flags, wallets and report
evidence live in the process and vanish on every deploy, restart or
spin-down. `scripts/backup-redis.sh` and [redis-backup.md](redis-backup.md)
apply only to a stack that has Redis (the compose/EC2 path, or Render with
`REDIS_URL` pointing at Upstash, whose free tier is itself persistent).
Evidence survives only when `EVIDENCE_S3_BUCKET` is set. What exactly is
lost is listed in [LIMITS.md](LIMITS.md).

## Incidents

| severity | examples | first steps |
|---|---|---|
| S1: nobody can use the product | `/healthz` down, canary failing twice in a row, frontend 404/500 | [host-down](runbooks/host-down.md) (the Render section), then [rollback](runbooks/rollback.md) if it started with a deploy |
| S2: product works, money or safety at risk | TURN egress spike, abuse wave, failed Razorpay webhooks | [turn-cost-spike](runbooks/turn-cost-spike.md), [abuse-wave](runbooks/abuse-wave.md); kill switch via `/admin` -> Flags |
| S3: degraded | slow matching, elevated `chizzy_call_failed_total`, one browser broken | open an issue, fix forward with the next merge |
| legal/safety | CSAM, NCII, law enforcement request, CERT-In | [csam-escalation](runbooks/csam-escalation.md), [ncii-takedown](runbooks/ncii-takedown.md), [law-enforcement-requests](runbooks/law-enforcement-requests.md), [cert-in-incident](runbooks/cert-in-incident.md); clocks start at receipt |

First five minutes for S1: `curl https://chizzy-api.onrender.com/healthz`;
`render logs -r srv-db5nnass728c738ek0o0 --tail`; Render dashboard
"Events" for a deploy that just went live; if yes, roll back; if the frontend
is the problem, `vercel ls chizzy-chat` and roll back the last Ready
deployment. Write a short post-mortem in the issue that closes it.

## On-call for one person

Daily (two minutes):

- `gh run list --workflow=canary.yml --limit 10` is all green or "skipped".
- Render dashboard: service "Live", no failed deploy, instance hours used
  this month (750 free; one always-on service uses ~744).
- `/admin` -> Reports queue: nothing older than the clocks in
  [retention.md](retention.md).
- Cloudflare TURN usage if `TURN_PROVIDER=cloudflare` (1 TB/month free).

Weekly:

- Merge the Dependabot group PRs that pass CI; close majors you are not taking
  with a comment.
- Vercel: delete preview deployments of merged branches if the Hobby quota
  warns.
- Read the error-level logs once: `render logs -r srv-db5nnass728c738ek0o0 --level error --limit 200`.
- Check that the last release tag matches what is live
  ([release runbook](runbooks/release.md)).

## Cost

| item | plan | monthly cost | cap to watch |
|---|---|---|---|
| Render web service | Free | 0 | 750 instance hours, spins down after 15 min idle, 100 GB egress |
| Vercel | Hobby | 0 | non-commercial only; 100 GB bandwidth; must leave before coin packs go on sale |
| Cloudflare Pages | Free | 0 | 500 builds/month (not used: CI uploads), unlimited bandwidth |
| Cloudflare Realtime TURN | Free | 0 up to 1 TB egress, then USD 0.05/GB | `TURN_SPEND_DAILY_GB` thresholds lower bitrate, then turn relay off |
| GitHub Actions | Free (public repo) | 0 | keep-alive (144/day) + canary (96/day) runs, each under a minute |
| Upstash Redis (when added) | Free | 0 | 500k commands/day |
| Razorpay | pay per transaction | 2% + GST on domestic cards/UPI, no fixed fee | settlement T+2 |

Total fixed cost today: zero. The first paid line will be Render Starter
(USD 7/month) to stop spin-down, or Redis if coin packs launch.

## SLOs

Only what can be measured with what exists:

| SLO | target | source |
|---|---|---|
| availability (session + match + call:start) | 99% of canary runs pass or skip over 30 days (about 2,880 runs, so 28 failures allowed) | `gh run list --workflow=canary.yml --json conclusion` |
| time to match | canary `match_ms` under 5 s on 95% of runs | canary log line `ok: ... {"match_ms": ...}` |
| time to connect | p95 of `chizzy_time_to_connect_seconds` under 5 s | `/metrics` histogram (resets per deploy) |
| wake-up | a spun-down service answers within 120 s | `keepalive.yml` curl `--max-time 120` |

The 5 s targets allow for ICE gathering on mobile networks; the canary's own
`match_ms` was 110 ms on the first production run. Review the targets after
the first month of canary data.
