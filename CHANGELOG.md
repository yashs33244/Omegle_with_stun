# Changelog

All notable changes to Chizzy are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases are tags
`vX.Y.Z` on `main`, cut with `scripts/release.sh` (see CONTRIBUTING.md).

## [Unreleased]

### Changed

- The production branch is `main` (renamed from `new-v`); workflows, Render, Vercel and the docs follow it.

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
