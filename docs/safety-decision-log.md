# Safety decision log

A dated record of every safety-relevant product decision: what was decided,
who decided, what else was considered, what the research recommended and why,
and what was done to reduce the risk of the chosen option. LAUNCH_PLAN LB-14
asks for this log because the question after an incident is "could you have
designed it differently?", and a record written at the time is the best
answer.

How to add an entry: append a new section at the end (never edit an old
entry's decision; add a later entry that changes it). Keep the wording
factual. Where a reason was not written down at the time, say so rather than
reconstruct one.

Sources: `.planning/BUILD_V1.md` (owner decisions), `.planning/research/LAUNCH_PLAN.md`
(the reviewed research plan, with the reports [R1] to [R6] it cites).

---

## 2026-10-04: launch decisions by the owner

Recorded by the infra-ops lane from BUILD_V1.md. **Owner action:** BUILD_V1.md
lists the decisions but, except for the services decision, not the reasons.
The "Reason recorded" lines below say "not recorded" where that is the case;
the owner should add the reasoning in a follow-up entry.

### D-1. Markets: global with a country blocklist

- **Decision.** Open globally except the UK, the EU and EEA (EU27, Norway,
  Iceland, Liechtenstein) and Australia. The blocklist lives in the
  `blocked_countries` flag (default `GB,AU,AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,NO,IS,LI`)
  so it can change without a deploy.
- **Alternatives considered.** (a) India only, as an allowlist; (b) India plus
  selected countries; (c) global minus the UK and Australia.
- **Research recommendation.** (a) India-only allowlist (LAUNCH_PLAN OD-4,
  LB-3). Reasons given: a blocklist leaves the US open (the A.M. v. Omegle
  product-liability theory, NCMEC reporting under 18 U.S.C. 2258A, the TAKE IT
  DOWN Act's 48 h removal duty, state minor-safety laws) and every other
  regime, which a solo operator cannot staff; liquidity is planned around one
  IST prime-time window anyway ([R4] sections 4.2 to 4.5). The UK and Australia
  were singled out because Ofcom says self-declared age is not "highly
  effective age assurance" and has fined small services, and Australia's
  eSafety Commissioner acted against OmeTV in 2025 ([R4]).
- **Reason recorded for the decision.** Not recorded in BUILD_V1.md.
- **Mitigations adopted.** Because the US is open, the build adds a TAKE IT
  DOWN notice-and-removal flow (`/api/takedowns`, 48 h ticket timer) and an
  NCMEC CyberTipline report packet (BUILD_V1). The country check uses
  Cloudflare's `CF-IPCountry` only when `TRUST_CLOUDFLARE=true`, and the
  gateway believes that header only from Cloudflare addresses; the origin
  can be locked to Cloudflare (`CLOUDFLARE_ONLY`, DEPLOYMENT.md). Runbooks
  cover NCMEC and NCII clocks.
- **Residual risk.** Exposure to US law and to users in many jurisdictions
  with one operator; VPN users can bypass a country block; the block is only
  as good as the Cloudflare proxy setup (LB-3 test from UK, US and EU exits
  is still required).

### D-2. Gender filter, profile photos, coins and Friends kept for everyone

- **Decision.** Keep all four as built, for every user.
- **Alternatives considered.** Gender filter off at launch or limited to
  verified adults; profile photos dropped for v1 or limited to verified adults
  with server-side classification; coins and the Friends badge hidden until
  they do something (v1.1).
- **Research recommendation.**
  - Gender filter: off at launch, gender not collected, then free for
    verified adults in v1.1 (OD-6). The reports disagreed: [R3] said keep it
    free and soft as a wedge against paywalled filters; [R4] called it "the
    predator's selection tool" and said gate it to verified users or disable
    it. The plan chose [R4]'s position.
  - Profile photos: drop for v1 (OD-7, LB-7). Photos are stored user content
    shown to strangers; classifying them on the uploader's own device does
    not work because the uploader controls that client; [R4]'s launch
    checklist item 6 says remove photos until server-side hash matching and
    classification exist.
  - Coins and Friends: hide until v1.1 (LB-13), because coins could not be
    spent and the Friends badge had no friends list ([R6]), which reads as a
    false claim.
- **Reason recorded for the decision.** Not recorded in BUILD_V1.md.
- **Mitigations adopted.** A partner's profile photo is blurred on the
  receiver's side until the receiver's on-device NSFW check passes (the
  receiver controls it, so a modified sender cannot turn it off); display
  names go through the name guard (slurs, handles, phone numbers; rejected
  names become a generated nickname); the gender filter is a hard constraint
  in matching, not a paid feature; this entry.
- **Residual risk.** The gender filter lets a user choose to meet only one
  gender, which [R4] associates with predatory targeting. Photos are not
  classified or hash-matched on the server, so illegal or intimate images can
  be sent through Chizzy's server to strangers before anyone reports them; the
  receiver-side blur depends on a classifier that is about 90 to 93% accurate
  on its own test set. Coins and Friends copy must not promise anything the
  feature does not do (copy rule).

### D-3. Match flow: Instant by default, 30 s Preview window

- **Decision.** Instant mode by default (the server accepts for the user and
  the call starts blurred); Preview (the accept card) is optional. The accept
  window stays 30 s. If the on-device blur fails its quality bar, Preview
  becomes the default through the `default_mode` flag.
- **Alternatives considered.** Preview by default; a 10 s accept window.
- **Research recommendation.** Instant by default, on the same condition
  (OD-8, LB-6), with a 10 s Preview window (D1, LB-9).
- **Reason recorded for the decision.** Not recorded for the 30 s window.
- **Mitigations adopted.** Receiver-side safe-start blur (3 consecutive safe
  frames before unblurring), the sender face gate, one-tap report on the
  video, the match card and a 60 s post-call screen, the `default_mode` flag.
- **Residual risk.** Instant mode removes the opt-in step, so a flash in the
  first seconds is contained only by the blur. After the first 10 s the
  classifier samples at about 0.5 fps, so a flash can stay visible for about
  2 s before it re-blurs. The blur quality bar and its bias test are not yet
  measured.

### D-4. Services: Cloudflare and free tiers, not Vercel

- **Decision.** Cloudflare for TURN, Turnstile and the proxy; free tiers of
  Sentry, PostHog Cloud (cookieless) and Better Stack. Not Vercel.
- **Alternatives considered.** Vercel for hosting; self-hosted coturn on the
  app host; self-hosted PostHog.
- **Research recommendation.** The same ([R5]; LAUNCH_PLAN LB-8, LB-11,
  section 5): relaying on the app host competes with signaling for the NIC
  and costs EC2 egress, the bundled coturn 4.7.0 image is vulnerable
  (CVE-2026-73212), and self-hosted PostHog needs about 4 GB of RAM.
- **Reason recorded for the decision.** Vercel cannot host the websocket
  backend, and its Hobby plan forbids commercial use (BUILD_V1.md).
- **Mitigations adopted.** coturn removed from docker-compose.yml; TURN
  credentials issued only per matched call with a 2 h TTL and hourly caps; a
  TURN spend poller that steps down bitrate, Hide my IP and then TURN.
- **Residual risk.** Cloudflare and the observability vendors process data
  outside India (to be listed in the Privacy Policy as cross-border
  processors). TURN cost is bounded by the poller, not by the client.

### D-5. Accounts: anonymous

- **Decision.** No accounts. A device id plus Turnstile plus a signed session
  token (24 h) and an age token (180 days).
- **Alternatives considered.** Optional verified-adult identity; mandatory
  accounts (Emerald model).
- **Research recommendation.** The same for launch, with an optional
  verified-adult identity in v1.1 (OD-2).
- **Reason recorded for the decision.** Not recorded; the decision matches
  the research, whose reason was that mandatory accounts cost the one-tap
  start users value ([R3]).
- **Residual risk.** Bans keyed on a device id, a fingerprint hash and IP
  ranges are easy to evade; on Indian mobile CGNAT an IP range is shared by
  many innocent users, so IP keys add friction rather than block.

### D-6. Legal text ships as drafts

- **Decision.** Terms, Privacy Policy, Guidelines and the other legal pages
  ship as templates marked "Draft, pending legal review". Public launch waits
  for the lawyer (LAUNCH_PLAN exit criteria).
- **Research recommendation.** The same (LB-1).

---

## 2026-10-12: address-level limits on fresh device ids

Recorded by the identity hardening lane. Changes nothing decided in D-5; it
narrows the evasion that D-5's residual risk describes, for the production
setup at the time (one Render instance, `TURNSTILE_DISABLED=true`).

### D-7. A ban reaches the banned device's address for 6 h; new device ids are capped per address per day

- **Decision.** Two limits at `POST /api/session`, both keyed on a salted hash
  of the client address (an IPv4 address or an IPv6 /64), never the address:
  (a) a `ban` (24 h or longer, always an admin decision) also refuses new
  sessions from the address the banned device last minted a session on, for
  6 h (`NETWORK_BAN_TTL_MS`), or until the ban ends or is lifted; pauses and
  warnings never reach the address. (b) At most 50 distinct new device ids
  (date-of-birth sessions) per address per UTC day
  (`SESSION_NEW_DEVICES_PER_NETWORK_PER_DAY`); returning devices renewing with
  their age token never count.
- **Problem.** Device ids are chosen by the client. Without Turnstile a script
  could mint a session for a fresh id at the per-IP session rate (10 a minute,
  14,400 a day) and so reset every per-device limit and step around a ban.
- **Alternatives considered.** Keying bans on the /24 (IPv6 /48), as the
  per-minute session limit does; a longer address ban (the ban's full length);
  a lower daily cap (10); turning Turnstile on (the real fix, kept for when the
  widget is configured, D-4).
- **Reason for the decision.** On Indian mobile carrier NAT one IPv4 address
  fronts many unrelated people (D-5), so the address is a weak and shared key.
  The limits are therefore narrow: the smallest block (/32, /64), a short
  window, only human bans, and a daily cap sized for a small app's new users
  per address rather than for people per address. Users on that address who
  already hold a 24 h session keep it; a returning device never meets the cap.
- **Mitigations adopted.** Strangers caught by an address ban see the
  restriction page without an appeal button and with the 6 h end time;
  lifting the ban lifts the address at once; the cap is an env value the
  operator can raise (docs/OPERATIONS.md); the address is stored only as a
  salted hash.
- **Residual risk.** Someone on the same carrier NAT as a banned user cannot
  start a first session for up to 6 h. One abuser sharing a carrier-NAT
  address can also use up the daily cap on purpose (50 date-of-birth
  sessions with random device ids, about 5 minutes at the per-IP rate):
  every other first visit from that address (new phone, cleared storage,
  private window) is then refused until UTC midnight. The refusal carries
  `Retry-After` up to midnight, existing sessions and age-token renewals are
  unaffected, and it lasts at most one day, so it is accepted. A determined
  evader with many addresses (mobile data toggling, VPNs) is slowed, not
  stopped; Turnstile and an optional verified identity (D-5) remain the
  stronger controls.
