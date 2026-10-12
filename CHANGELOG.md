# Changelog

All notable changes to Chizzy are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases are tags
`vX.Y.Z` on `main`, cut with `scripts/release.sh` (see CONTRIBUTING.md).

## [Unreleased]

### Changed

- The production branch is `main` (renamed from `new-v`); workflows, Render, Vercel and the docs follow it.

### Security

- Session gate: the restriction check at `POST /api/session` was never wired in production, so a banned device got a fresh token; bans now follow the device and its fingerprint link and the CSAM packet carries the noted IP and country. The proxy IP header is believed only when it holds one IP literal, list headers (`X-Forwarded-For`) are refused at boot, and production refuses placeholder secrets.
- HTTP: bounded Node server timeouts (15 s headers, 30 s request, 65 s keep-alive, 100 headers, 1,000 requests per socket); on every JSON and raw body router, including billing and its webhook, an over-cap `Content-Length` is refused before the body is read and compressed bodies are refused (the webhook MAC now always covers the bytes as sent); Turnstile verifications capped at 64 in flight.
- Sockets: per-IP cap and connect rate enforced on the upgrade so refused attempts hold nothing; websocket-only transport; a 30 s hello deadline; per-connection packet and byte budgets ahead of JSON parsing; a per-session socket cap; unchanged preference updates no longer reload the queue; a matches-per-minute cap and an accept-expiry penalty.
- Store: the Redis match lock is renewed and token-fenced so a slow pass can no longer let two replicas match the same pair; matching status is memoized (a closed `staffed_hours` window cost 60 ms per `GET /api/config`); the memory store forgets reporter indexes after the retention window; key parts are validated; one Redis client option set with command timeouts.
- Billing: a pack is credited once per order (two captured payments for one order no longer double-credit), the credit claim survives a failed ledger write, unpaid orders expire after 24 h and are capped per device, and `initialCoins` defaults to 0 so a fresh device id cannot unlock the gender filter for free.
- Safety: captions pass through the chat guard with a byte budget, reports are bucketed per IP, reporters on one address count once toward automatic action, admin restriction durations are limited to the ladder, the open-report queue and memory enforcement store are bounded, and appeal quotas are charged only for the device's own restrictions.
- Frontend: "Hide my IP" fails closed (no connection until the user continues or skips), the fake-Checkout seam is dropped from production bundles, HSTS added, non-major audit fixes.
- Infrastructure: gateway `limit_req`/`limit_conn` zones and slow-client timeouts; unknown paths answered at the gateway; containers run with all capabilities dropped, read-only root, memory and pid limits on three isolated networks; workflows no longer persist credentials, publish from a shared cache or release outside a protected environment; zizmor runs in CI; `check-deploy-env.sh` diffs `config.ts` against the deploy surface.
- Load shedding: an instance-wide socket cap (`MAX_CONNECTIONS_TOTAL`, 503 `server_full`) and session rate (`SESSION_RATE_TOTAL_PER_SEC`); a load monitor on event-loop delay and heap refuses new sockets and sessions with 503 and `Retry-After` while keeping live calls served and `/healthz` green (`/readyz` turns 503), with hysteresis and `chizzy_overloaded` / `chizzy_shed_total` metrics.
- Bounds: per-IP bucket maps evict refilled and least-recently-used entries instead of clearing everyone's limits at 50,000 keys; in-memory and gateway per-IP limits key on the IPv4 address or IPv6 /64; call stats, wallet claims, idle ledgers and lapsed unlocks expire; an instance-wide photo byte budget; pending rooms indexed in the memory store; every string in the protocol carries a length cap.
- Identity: sockets are disconnected at their session token's expiry (`session_expired`, the SPA re-mints silently); a ban follows the banned device's address for 6 h and new device ids per address are capped per day (`SESSION_NEW_DEVICES_PER_NETWORK_PER_DAY`); admin bad tokens are limited per /64 and instance-wide without locking out a clean address; `ADMIN_ALLOWED_IPS` takes CIDR blocks; `ADMIN_TOKEN` must be 32+ characters in production.
- Operations: the TURN spend cap steps relay down after an hour of failed analytics polls instead of failing open; evidence reads are size- and type-checked and downloaded as attachments; a failed evidence delete no longer stops the retention sweep; the audit log is swept; admin wallet adjustments accept an `Idempotency-Key`; backend Sentry events are budgeted and scrubbed; the frontend nginx has slow-client timeouts and a connection limit.
- Clients: reconnects use full-jitter backoff honouring `Retry-After` with at most six attempts a minute, so a restart no longer brings every client back in the same instant; busy refusals show a retrying state instead of the paused screen.
- Testing: property-based suites send arbitrary payloads to every socket event and REST route and assert no handler error, one ack, nothing relayed for refused input, bounded time and heap; a schema introspection test requires a max on every string and array. CodeQL default setup runs on every push.

## [1.0.0] - 2026-10-11

First versioned release: the launch build merged through #1, #2, #23 and #24.

### Added

- Session gate: `POST /api/session` verifies Turnstile, computes 18+ server-side from a date of birth that is never stored, records ToS acceptance, applies the country blocklist and returns a signed session token required by the socket handshake (#2).
- Runtime config and kill switch: `GET /api/config`, operator flags stored in Redis and editable from the admin API, `matching:status` and `server:banner` pushed to clients (#2).
- Instant and Preview matching modes with a relaxation ladder, shared topics on the match card, per-call TURN credentials from Cloudflare Realtime with hourly caps and a spend poller (#2).
- Enforcement v2: reports with evidence, reporter weighting, graduated restriction ladder, appeals, NCII takedown tickets and CSAM escalation with an audit log (#2).
- Admin console at `/admin` behind `ADMIN_TOKEN` and optional `ADMIN_ALLOWED_IPS` (#2).
- Safety UX: chat guard for contact details, name guard, safety nudges, first-use safety card, remote-video watermark and one-tap report (#2).
- On-device moderation: sender face gate and receiver NSFW blur with self-hosted models under `/models/` (#2).
- Observability: Sentry and PostHog loaded only when configured, call telemetry as Prometheus metrics, opt-in GitHub Actions canary (#2).
- i18n with English and Hindi resources, SEO (robots, sitemap, prerendered route meta, manifest) (#2); Hindi copy rewritten in everyday register (#24).
- Coin-based premium gender filter paid through Razorpay with exactly-once credit, wallet and admin order views (#23).
- Spark shared icebreakers and live captions relayed to the partner only, with on-device translation when available (#23).
- Mobile-first start screen, settings and profile bottom sheets, full-bleed call screen with a 56 px action bar (#23).
- Accessibility audit with axe (WCAG 2.1 AA) in Playwright; focus return and keyboard handling in the sheet primitives (#24).
- Cloudflare Pages deploy (`pages.yml`, opt-in) with `_headers` generated from the same source as `vercel.json` and nginx (#24).
- Redis store with `@socket.io/redis-adapter` for N backend replicas, nginx gateway, Compose stack, nightly Redis backup and restore scripts, runbooks, capacity and retention docs (#1, #2).
- CI: protocol, lockfile, pin, deploy-script, env and header guard scripts; backend, frontend, Playwright, Docker and Compose-stack jobs; actionlint and shellcheck (#1, #24).

### Changed

- Backend rewritten around `MatchService` and a `MatchStore` interface (memory and Redis); every socket payload validated with zod at the boundary (#1).
- Production runtime is Node 22 (Bun stays the package manager, build tool and test runner) after Bun accepted oversized websocket frames (#1).
- Socket protocol moves to v3 (`backend/src/protocol.ts`, synced to the frontend by `scripts/sync-protocol.sh`); v2 clients are rejected (#2).
- Accept-window expiry re-queues the member who accepted and idles the one who did not (#2).
- Frontend WebRTC rewritten: one `RTCPeerConnection` per call, queued ICE candidates, single initiator, ICE restart, bitrate caps (#1, #2).
- Landing critical path split into vendor chunks and lazy routes: 24% fewer JS bytes, TBT 0 ms on the Lighthouse mobile profile (#24).
- Backend modules use named constants and split store contracts; conventions documented in `docs/engineering-conventions.md` (#23).

### Fixed

- Malformed socket events no longer crash the process; room relays are enforced per membership and room status (#1).
- Users are re-queued after skip, decline, timeout, report and partner disconnect, with a pair cooldown to stop rematch loops (#1).
- iOS tab-switch recovery, wake lock during calls, camera flip and pre-flight check on phones (#2).
- 18 UX issues from the phone screenshot audit: report sheet, action bar at 360 px and in landscape, Spark card and chat toast clear of the PiP, topic names in the UI language (#24).

### Security

- Content Security Policy, unprivileged nginx images, pinned action SHAs, lockfiles restricted to the public npm registry, tracked `.env` and third-party loader script removed (#1).
- Evidence frames scrubbed from Sentry events, device ids pseudonymised in the admin console, evidence blurred by default (#2).
- Server-enforced `premium_required`; Razorpay webhook signature verification; `RAZORPAY_FAKE` refused in production (#23).

[Unreleased]: https://github.com/yashs33244/Omegle_with_stun/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/yashs33244/Omegle_with_stun/releases/tag/v1.0.0
