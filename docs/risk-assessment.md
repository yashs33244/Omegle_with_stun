# Illegal content and child safety risk assessment (template, pre-filled)

**Status: DRAFT, pre-filled by engineering on 2026-10-04. The owner completes
it, the lawyer reviews it, and it is re-done before launch and on every
review trigger below.**

Structure: Ofcom's four-step risk assessment (understand the harms, assess
the risk, decide and implement measures, report, review and update). The UK
is geo-blocked at launch, so the UK Online Safety Act duties are not the
reason for this document; research 04 section 12 recommends the four-step
structure anyway as the best written evidence of "reasonable design" if the
product's design is ever questioned (the A.M. v. Omegle theory).

Sources: `.planning/research/LAUNCH_PLAN.md`, `.planning/BUILD_V1.md`,
research [R3] pain points and [R4] trust-safety-legal. Numbers marked
"vendor" are vendor or test-set figures, not Chizzy measurements.

---

## Step 1. Understand the service and the harms

### Service characteristics (risk factors)

| Characteristic | Chizzy v1 | Why it matters |
|---|---|---|
| Strangers matched at random for 1:1 live video | Core feature | Live, unmoderatable-by-server content; first seconds are the riskiest |
| Anonymous, no accounts | Device id + Turnstile + session token | Weak identity; bans are evadable |
| Adults only, self-declared | Date of birth + 18+ attestation, under-18 lockout | Children who lie get in; DOB is a floor, not a check |
| Peer-to-peer media | Default; TURN relay optional ("Hide my IP") | Server never sees video; partner sees the user's IP by default |
| Text chat during calls | Relayed by the server, not stored | Contact-sharing and grooming channel |
| Profile photos and display names | Kept for everyone (owner decision D-2) | Stored-and-shown user content |
| Gender filter | Kept for everyone (owner decision D-2) | Lets a user target one gender |
| Markets | Global except UK, EU/EEA, Australia (owner decision D-1) | US and many other regimes apply |
| Operator | One person plus a backup reviewer, staffed hours | Legal clocks need someone reachable |

### Harms in scope

Child sexual exploitation and abuse (grooming, live sexual abuse, CSAM);
intimate image abuse and unwanted sexual exposure (flashing); sextortion and
fraud; harassment, threats and hate; encouraging self-harm; privacy harms
(IP exposure, recording, doxxing); terrorism and violent content; illegal
sales (drugs, weapons). Children accessing an adult service is assessed
alongside (it multiplies the other risks).

---

## Step 2. Assess the risk

Likelihood and impact: Low / Medium / High, judged before launch data exists.
Re-score with beta and launch metrics (reports per 1,000 calls, blur triggers,
`underage` reports, appeals overturned).

| Harm | Likelihood | Impact | Risk | Main drivers |
|---|---|---|---|---|
| Children on the service (lying about age) | High | High | **High** | Self-declared age; random stranger matching; mobile-first audience |
| Grooming and contact moved to other apps | High | Severe | **High** | Live 1:1 with strangers; chat; gender filter |
| Live sexual abuse of a child / CSAM | Medium | Severe | **High** | Same; P2P means no server-side detection |
| Unwanted sexual exposure (flashing) | High | Medium | **High** | Category's core abuse pattern ([R3]); Instant mode default |
| Intimate image abuse (recording, sharing) | Medium | High | **High** | Anyone can screen-record; photos and evidence are stored content |
| Sextortion and scams (bots, financial sextortion) | High | High | **High** | Free unlimited Next; scam bots in the category ([R3]) |
| IP exposure and doxxing | High (by design) | Medium | **High** | P2P reveals IP to the partner unless Hide my IP is on |
| Harassment, threats, hate | High | Medium | **Medium** | Anonymous strangers; audio is not moderated |
| Encouraging self-harm | Low | High | **Medium** | Strangers; no detection |
| Terrorism or violent content | Low | High | **Low** | Ephemeral 1:1; no broadcast |
| Illegal sales (drugs, weapons) | Low | Medium | **Low** | No payments, no listings |

---

## Step 3. Measures: in place, planned, and gaps

### In this build (BUILD_V1, verify each at integration)

| Measure | Harms addressed | Notes |
|---|---|---|
| DOB gate + 18+ attestation + ToS record; under-18 lockout (salted hash) | Children on the service | Tier 1 only: stops honest children |
| `underage` reports jump the queue; pause only when corroborated | Children, grooming | Prevents a single throwaway device pausing anyone |
| Sender face gate (no face for 3 s -> blurred placeholder) | Flashing, fake video | On-device; a modified client can bypass its own gate |
| Receiver safe-start blur (3 safe frames before unblur; tap-to-show fallback) | Flashing, CSAM exposure | Controlled by the receiver; classifier about 90 to 93% on its own test set (vendor) |
| Partner photo blurred on the receiver until checked; name guard | Sexual images, slurs, handles | Photos are not checked on the server |
| Chat guard (links, handles, phones hidden for 2 min) + safety nudges + safety card with helplines | Grooming, sextortion, scams | Cannot catch a handle written on paper or shown on video |
| Faint per-session watermark | Recording | Deters and traces; does not prevent recording |
| Report v2 with evidence (frame + 20 chat lines), one tap on video, card, post-call | All | Evidence is reporter-supplied, labelled unverified |
| Reporter weighting; automatic action capped at a temporary pause; ladder to permanent by humans only | Report abuse | |
| Restriction screen with reason, duration, free appeal | Wrongful bans | |
| Admin queue by severity with SLA timers; evidence blurred and greyscale by default; audit log | All; reviewer wellbeing | |
| CSAM escalation: restricted store, 1-year freeze, NCMEC/NCRP packet built without opening the file | CSAM | |
| NCII takedown form and tickets | Intimate image abuse | Console timer 48 h; runbook works to India's 24 h |
| Turnstile, per-IP and /24 buckets, hourly match caps | Bots, scraping | |
| Hide my IP (relay only), flag-gated | IP exposure | Opt-in; the spend poller can turn it off |
| Country blocklist via Cloudflare, origin lockable to Cloudflare | Regulatory | VPNs bypass it |
| Kill switch flags, staffed hours, banner | All (operational) | |
| Runbooks with legal clocks; safety decision log | All | docs/runbooks/, docs/safety-decision-log.md |

### Known gaps (be explicit)

| Gap | Effect | Plan |
|---|---|---|
| **No age estimation.** The on-device age risk signal (LB-2 Tier 2) is not built: it needs a lawful, bias-tested evaluation set we do not have | A child who enters an adult birth date is matched like anyone else until reported | v1.1 verified-adult badge (D9); pre-committed stop rule: if `underage` reports pass the agreed rate, verification becomes mandatory |
| **P2P IP exposure by default.** The partner's browser receives the user's IP unless Hide my IP is on | Doxxing, IP-locator extensions | Disclose in the Privacy Policy; keep Hide my IP available; review the default after beta |
| **No server-side frame sampling** (no Sightengine or Hive) | Nothing is detected unless a user reports or an on-device check fires | Budget decision for v1.1 (about $1 per user-hour if every call is sampled, vendor) |
| No hash matching on live video; photos not hash-matched or classified on the server | Known CSAM in a profile photo is not caught automatically | Server-side classification and hashing before photos can be considered safe; owner decision D-2 kept photos |
| On-device checks run on the user's own device | A modified client can turn off its own face gate and ignore bitrate caps | The receiver-side blur is the protection that does not depend on the sender |
| Classifier sampling drops to about 0.5 fps after 10 s | A flash can stay visible about 2 s before re-blur | Measure the blur trigger rate in beta |
| Gender filter kept for everyone | Targeting by gender | Owner decision D-2; monitor reports by reported/reporter gender filter use |
| Audio is not moderated | Verbal harassment and grooming only via reports | Reports; nudges on chat only |
| Device-based bans | Evadable by clearing site data or a new device | Turnstile friction; v1.1 verification |
| Logs not yet kept 180 days in India | CERT-In non-compliance; weaker investigations | Launch checklist: ship logs to an India-region store |
| Legal text is a draft | Terms and policies not yet enforceable as written | Lawyer before public launch |
| Solo operator | Legal clocks missed when unavailable | Backup reviewer, staffed hours, stop rules |

---

## Step 4. Report, review and update

- **Owner of this document:** the owner (accountable person).
- **Record:** keep each version in git (this file) with the date and who reviewed it.
- **Review triggers:** before public launch; monthly for the first three
  months, then quarterly; after any CSAM incident, regulator or police notice,
  or a stop rule firing; before opening any blocked country; before turning
  on any new feature that changes who meets whom (photos, friends, filters).
- **Metrics to bring to each review:** reports per 1,000 calls by reason,
  share upheld, appeals overturned, blur triggers per 1,000 calls,
  model-fallback rate, `underage` reports per 1,000 sessions, queue items past
  their SLA, early-skip and virtual-camera rates, geo-block test results
  (UK, US and EU exits).

| Date | Version | Reviewed by | Changes |
|---|---|---|---|
| 2026-10-04 | 0.1 (draft) | Engineering (pre-fill) | First version from the launch plan and build spec |
