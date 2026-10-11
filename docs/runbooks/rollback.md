# Runbook: rollback

Use when a deploy broke production and reverting the code would take longer
than putting the previous build back. Rolling back does not undo the commit:
once the site is healthy, open a revert PR (or fix forward) so the next merge
to `new-v` does not redeploy the bad version.

Pick the part that broke. Frontend and backend deploy independently; roll
back only the one that changed. The protocol version (`backend/src/protocol.ts`,
`new-frontend/src/protocol.ts`, kept in sync by `scripts/sync-protocol.sh`)
must match between the two, so a change that bumped it needs both rolled
back together.

## Frontend on Vercel

```sh
cd new-frontend
vercel ls chizzy-chat                         # deployments, newest first; note the previous Ready production URL
vercel rollback <deployment-url-or-id> --yes  # points chizzy-chat.vercel.app at it, no rebuild
vercel rollback status chizzy-chat
```

Dashboard: project `chizzy-chat` -> Deployments -> the previous production
deployment -> "..." -> "Instant Rollback" (or "Promote to Production" on any
older deployment). Both complete in seconds; a rollback is served from the
old build's static files, no edge cache purge needed.

Because Vercel auto-deploys every push to `new-v`, the next merge replaces
the rolled-back build. Revert first, then merge.

## Backend on Render

Service `srv-db5nnass728c738ek0o0` (`chizzy-api`, Free, singapore).

```sh
render deploys list srv-db5nnass728c738ek0o0 -o json   # find the last deploy with "status": "live" before the bad one; copy commit.id
render deploys create srv-db5nnass728c738ek0o0 --commit <previous-commit-sha> --wait
```

`--wait` streams the Docker build and exits non-zero if the deploy fails;
expect three to five minutes. Render keeps the current instance until the new
one passes `/healthz`, so a failed rollback build leaves the bad version
running rather than nothing.

Dashboard: https://dashboard.render.com/web/srv-db5nnass728c738ek0o0 ->
Events -> the previous live deploy -> "Rollback to this deploy". That reuses
the already built image, so it is faster than a commit redeploy.

API (no CLI at hand):

```sh
curl -sS -H "Authorization: Bearer $RENDER_API_KEY" \
  https://api.render.com/v1/services/srv-db5nnass728c738ek0o0/deploys?limit=10
curl -sS -X POST -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
  -d '{"commitId":"<previous-commit-sha>"}' \
  https://api.render.com/v1/services/srv-db5nnass728c738ek0o0/deploys
```

Auto-deploy stays on (`autoDeployTrigger: commit`), so the next push to
`new-v` deploys again. To freeze while you investigate: Settings -> Build &
Deploy -> Auto-Deploy "No", or `render services update srv-db5nnass728c738ek0o0 --auto-deploy=false`.

## Frontend on Cloudflare Pages

Only when `PAGES_ENABLED=true` and `chizzy.pages.dev` is the live site.
`wrangler` has no rollback subcommand for Pages; there are two ways:

```sh
npx wrangler@4 pages deployment list --project-name chizzy          # find the previous production deployment
```

then in the dashboard: Workers & Pages -> `chizzy` -> Deployments -> the
previous production deployment -> "..." -> "Rollback to this deployment"
(instant, served from the old upload). Or rebuild the old commit and upload
it as a new production deployment:

```sh
git checkout <previous-commit-sha> -- new-frontend
cd new-frontend && npm ci && VITE_API_URL=https://chizzy-api.onrender.com VITE_SITE_URL=https://chizzy.pages.dev npm run build
npx wrangler@4 pages deploy dist --project-name chizzy --branch new-v
git checkout new-v -- new-frontend
```

## Compose on a host (EC2 path, paused)

Only applies when `deploy.yml` is deploying to a host again. On the host:

```sh
cd ~/Omegle_with_stun
cat .deployed-tag                 # the tag that last passed verification
bash deploy/deploy.sh <previous-sha>
```

`deploy/deploy.sh` keeps `.env`, pulls the sha-tagged images, runs
`up --wait`, checks health and rolls back by itself when the check fails.
It only works when the older sha used the same `docker-compose.yml` and
gateway config; across such a change re-run that commit's successful Deploy
workflow instead (DEPLOYMENT.md "Rollback by hand").

Releases (tags) do not deploy anything, so `gh release delete vX.Y.Z
--cleanup-tag` is a bookkeeping step, not a rollback; see
[release.md](release.md).

## Verify

```sh
curl -sS -o /dev/null -w "%{http_code}\n" https://chizzy-api.onrender.com/healthz    # 200
curl -sS https://chizzy-api.onrender.com/api/config                                 # matchingOpen true, expected tosVersion
curl -sS -o /dev/null -w "%{http_code}\n" https://chizzy-chat.vercel.app/            # 200
CANARY_URL=https://chizzy-api.onrender.com node scripts/loadtest/canary.ts          # two clients reach call:start (needs backend/node_modules)
gh workflow run canary.yml --ref new-v && gh run watch                               # same, from GitHub
```

Optionally the browser test against production (the canary already covers
the socket path; this adds the real SPA, camera prompt and photo flow):

```sh
cd new-frontend && E2E_BASE_URL=https://chizzy-chat.vercel.app npx playwright test e2e/call.spec.ts
```

`call.spec.ts` opens two pages, onboards them on the topic "music" and
expects the Preview-mode match prompt. Against production that means: run it
when `default_mode` is `preview`, and expect flakes when real users are
online because the two test pages can be matched with them (the canary
avoids that with the `zxx` language; the spec does not). It creates two
sessions and nothing else: no reports, bans or purchases. Do not run the
whole e2e suite against production (`admin.spec.ts` needs `ADMIN_TOKEN` and
changes flags).

## What is lost

Every Render deploy or rollback restarts the single instance. With the
in-memory store that drops: live sessions and calls (users see "reconnecting"
and must re-enter the gate), the waiting queue, bans and lockouts, operator
flags (back to defaults: matching open, no banner), wallets and payment
records (which is why billing is off without Redis), report evidence on the
ephemeral disk unless `EVIDENCE_S3_BUCKET` is set, and all metrics counters.
A Vercel or Pages rollback loses nothing server-side; users with the old
bundle cached pick up the change on next load.

The complete list, with the file that proves each item, is in
[../LIMITS.md](../LIMITS.md) ("what is lost when something restarts").
