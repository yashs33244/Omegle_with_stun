# Data retention

The retention table from LAUNCH_PLAN LB-16 (based on research
04-trust-safety-legal.md section 10). **The lawyer confirms it before
launch**; it feeds the Privacy Policy and the storage lifecycle rules.
Retention should be enforced by the storage itself (expiry, lifecycle rules),
not by someone remembering to delete.

| Data | Retention | Legal driver | Where it lives in v1 | How it is enforced in v1 |
|---|---|---|---|---|
| ICT and application logs (connections, IPs, matches) | 180 days rolling, stored in India; 1 year from DPDP phase 3 (May 2027) | CERT-In Directions 2022; DPDP Rule 8(3) | Container logs on the host (JSON, pino) and the gateway access log | **Gap**: Docker rotates logs at 10 MB x 3 files per container, far short of 180 days, and nothing ships them to an India-region store yet. Launch checklist item. |
| Reports and non-CSAM evidence (frame, chat lines) | 1 year, then automatic delete | DPDP Rule 8(3); IT Rules 3(1)(g) (180 days minimum) | Redis (report metadata); `evidence-data` volume or the S3 evidence bucket | Backend enforcement lane (expiry on write); S3 lifecycle rule when `EVIDENCE_S3_BUCKET` is used. Verify at integration. |
| CSAM-suspected evidence and report metadata | 1 year after the report, or until the legal hold ends if later; restricted store | REPORT Act (US); POCSO | Restricted part of the evidence store | The `escalate_csam` action puts the report on legal hold until 1 year after the escalation (`preservedUntil`); escalating again renews it. The daily sweep (`EnforcementService.sweepRetention`) keeps a held report until `preservedUntil` has passed, then deletes it with its evidence and audit trail like any other report older than a year. `POST /admin/api/reports/:id/release-hold` ends a hold early (audited as `report.release_hold`). S3 Object Lock recommended for the S3 store. Verify at integration. |
| Ban and restriction records (hashed device keys) | Ban duration + 1 year | Legitimate interest, security | Redis | Expiry set when the restriction is written. Verify at integration. |
| Admin audit log (action, target id, note, admin IP) | 1 year after the entry, then automatic delete; entries about a report on legal hold stay with it | Security; accountability for moderator actions | Redis (`audit` collection) | Daily retention sweep (`EnforcementService.sweepRetention`). |
| Age-gate outcome (over 18, ToS version, time) | While the device is active + 180 days | IT Rules 3(1)(h) | Signed age token in the browser (180 days); server record as built by the session lane | Token expiry. Verify at integration. |
| Under-18 lockout | Salted hash and date only; nothing else | DPDP (no minors' data) | Redis | Session lane. Verify at integration. |
| Date of birth | Not stored (outcome only) | DPDP minimisation | Nowhere: the server computes 18+ and discards it | By design (protocol v3 `/api/session`). |
| Chat messages | Not stored, except the lines attached to a report | Minimisation | Relayed in memory only | By design. |
| Video and audio | Never recorded; only the report-time frame | Minimisation | Peer to peer or via the TURN relay (encrypted, not readable by the relay) | By design. |
| Call telemetry | No IPs; aggregate after 90 days | Minimisation | Prometheus counters and histograms | Metrics carry no IPs or ids by design; keep the metrics backend's retention at or under 90 days. |
| Redis backups (snapshot of all of the above in Redis) | 35 days | Operations | S3 backup bucket, local `backups/redis` (7 copies) | S3 lifecycle rule (docs/redis-backup.md); local pruning by the backup script. A deleted record can live on in a backup for up to 35 days; the Privacy Policy should say so. |
| Product analytics (PostHog) | Per PostHog plan; no IP capture, cookieless | Minimisation | PostHog Cloud (outside India) | Frontend config (IP capture off, no session recording). |
| Error reports (Sentry) | Per the Sentry plan (check the current free-tier retention) | Operations | Sentry (outside India) | `beforeSend` scrubbing removes names, chat, photos and evidence. |

## Notes

- **Cross-border processors** (Cloudflare, Sentry, PostHog, Better Stack,
  AWS outside `ap-south-1`) must be listed in the Privacy Policy (LB-1).
- **Peer-to-peer IP disclosure**: in default mode the partner's browser
  receives the user's IP address. This is not stored by Chizzy, but it is a
  disclosure the Privacy Policy must state, with "Hide my IP" as the way to
  avoid it (LB-1).
- **Legal holds**: an order or a CSAM escalation suspends deletion for the
  records it names. A CSAM escalation holds the report for 1 year from the
  escalation; for a longer order, escalate again before `preservedUntil`
  (each escalation renews the year and is audited). When the process is
  closed, release the hold with `POST /admin/api/reports/:id/release-hold`
  (optional `{ note }`, audited); the report then follows normal retention
  and goes at the next sweep if it is over a year old. Record the hold and
  its release in the request log (docs/runbooks/law-enforcement-requests.md).
