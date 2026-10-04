# Launch checklist (owner tasks)

Things only the owner can do, plus the pre-launch tests that need the real
accounts. Code work is tracked in `.planning/BUILD_V1.md`. Launch is gated by
the exit criteria in LAUNCH_PLAN section 6, not by a date.

## Legal and business

- [ ] Hire a lawyer: Indian tech law plus online safety (UK/US specialist for the US exposure). Every LAWYER item in the runbooks goes to them.
- [ ] Incorporate (Pvt Ltd or LLP), open the bank account, check the employment contract allows the venture and does not claim its IP.
- [ ] Ask the lawyer about cyber or media liability insurance.
- [ ] Lawyer drafts the Terms, Privacy Policy (including the P2P IP disclosure, cross-border processors and docs/retention.md), Community Guidelines, Grievance, Safety, Law-enforcement and Takedown pages. Replace every "Draft, pending legal review" page.
- [ ] Lawyer confirms the retention table (docs/retention.md) and the runbooks (docs/runbooks/).
- [ ] Lawyer reviews the market decision (docs/safety-decision-log.md D-1): US duties (18 U.S.C. 2258A, REPORT Act, TAKE IT DOWN Act, state laws) and whether the geo-block keeps the UK, EU and Australia out of scope.
- [ ] Register with NCMEC as an electronic service provider (email NCMEC's ESP team) and get CyberTipline reporting access.
- [ ] Set up the India police reporting route (NCRP at cybercrime.gov.in, local SJPU contact) for POCSO s.19.
- [ ] Name the Grievance Officer and publish the contact on the Grievance page.
- [ ] Name and train one backup reviewer (NDA), with access to `/admin` and the runbooks.
- [ ] Create the mailboxes: `grievance@`, `legal@`, `lawenforcement@`, `support@`.
- [ ] Fill in the reasons in the safety decision log (D-1 to D-3 say "not recorded").
- [ ] Complete and sign the risk assessment (docs/risk-assessment.md).

## Accounts and keys

- [ ] Domain: a dedicated domain, categorised with the main web-filter vendors.
- [ ] Cloudflare: zone for the domain; both the SPA and the API hostname **proxied** (orange cloud).
- [ ] Cloudflare: Turnstile widget for the SPA hostname -> `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`.
- [ ] Cloudflare: Realtime TURN key -> `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`; set `TURN_PROVIDER=cloudflare`.
- [ ] Cloudflare: account id and a read-only Analytics API token -> `CF_ACCOUNT_ID`, `CF_ANALYTICS_TOKEN`; set the daily TURN spend thresholds.
- [ ] Cloudflare: Access application in front of `https://<api>/admin/api/*` (and `/admin` on the SPA), one-time PIN or Google login for the owner and the backup reviewer.
- [ ] Cloudflare: billing notification for Realtime usage.
- [ ] Sentry: two projects (backend, frontend) -> `SENTRY_DSN`, `SENTRY_DSN_FRONTEND`.
- [ ] PostHog Cloud: project with IP capture off and session recording off -> `POSTHOG_KEY`, `POSTHOG_HOST`.
- [ ] Better Stack: monitors for `/healthz` on both hostnames, a status page, phone alerts.
- [ ] AWS: Budgets alerts at $20, $50, $100; CloudWatch alarms on `StatusCheckFailed`, `CPUCreditBalance`, `NetworkOut`; EC2 auto-recovery.
- [ ] AWS: S3 buckets in `ap-south-1` for Redis backups (`BACKUP_S3_URI`) and, if used, evidence (`EVIDENCE_S3_BUCKET`, with KMS, lifecycle rules per docs/retention.md and Object Lock for the CSAM hold); instance role with only the needed actions; IMDSv2 hop limit 2.
- [ ] AWS (or another India-region store): log shipping with 180 days retention for CERT-In. **Not built yet.**
- [ ] Generate `SESSION_SECRET` and `ADMIN_TOKEN` (`openssl rand -hex 32`) and add every secret listed in DEPLOYMENT.md to GitHub.
- [ ] Security group: 443 (and 80) from Cloudflare ranges only, SSH from your IP only (or SSM); then set `CLOUDFLARE_ONLY=true` and `TRUST_CLOUDFLARE=true`.

## Operations

- [ ] Set `staffed_hours` in `/admin` -> Flags (for example `20:00-24:00 Asia/Kolkata`) and check the closed message.
- [ ] Check `blocked_countries` and test the block from UK, US and EU exits (a commercial VPN and a cloud VM); record the result in the risk assessment.
- [ ] Nightly Redis backup cron on the host (docs/redis-backup.md) and one tested restore on staging.
- [ ] Canary: a staging stack with the Turnstile test secret, then set the `CANARY_URL` repository variable; confirm a failed run reaches you.
- [ ] Load test at 3,000 sockets and a 2 h soak on staging; record in docs/capacity.md.
- [ ] Print the runbooks and rehearse each once.

## Drills (LB-16, all must pass)

- [ ] 30 synthetic reports across all reasons, cleared inside their SLA timers.
- [ ] CSAM dry run with a harmless test file: report to packet without anyone opening the file.
- [ ] Every kill-switch flag flipped on staging (matching, new sessions, TURN, Hide my IP, default mode, banner, staffed hours).
- [ ] Sybil test: 3 fresh incognito devices cannot ban or pause a normal user.
- [ ] TURN spend chain tested end to end (bitrate, then Hide my IP, then TURN off, with alerts).
- [ ] Relay-forced call test passes.

## Beta and launch gate

- [ ] Closed beta with adult seed users only, staffed hours only; adult-only recruiting and creatives.
- [ ] Beta metrics within the stop rules (`underage` reports, blur trigger rate, connect rate at least 97% within 10 s).
- [ ] Instant vs Preview default decided from the blur quality bar (`default_mode`).
- [ ] Lawyer sign-off.
- [ ] Claim the Trustpilot profile.
