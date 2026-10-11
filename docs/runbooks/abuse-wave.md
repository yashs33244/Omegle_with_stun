# Runbook: abuse wave (nudity, bots, spam, raids)

Owner: the on-duty reviewer; the owner decides on closing matching.
Sources: LAUNCH_PLAN LB-5, LB-10, LB-11, LB-16; research 05-tech-launch.md section 11 (incident playbook).

## Signs

- Reports per 1,000 calls jump, or many reports name the same few devices.
- Blur triggers (`nsfw-blur` moderation signals) per 1,000 calls jump.
- Early-skip or virtual-camera signals rise; many sessions from one ASN or
  /24; Turnstile solve rate drops.
- Chat redactions and `safety:nudge` events spike (link or handle spam).
- Social media or app-store reviews mention a specific abuse.

## Steps, lightest first

1. **Banner** (`/admin` -> Flags -> `banner_message`): a short, honest line,
   for example "We are dealing with a wave of spam. Report anything that
   breaks the rules."
2. **Work the queue** by severity (minor > nudity > harassment/hate/violence >
   spam/fake > other). Restrict repeat devices; report-driven automatic
   actions only pause, so a human decides anything longer.
3. **Switch the default to Preview** (`default_mode` = `preview`) so people
   see a card before video. Do this at once for a nudity wave.
4. **Raise friction at the edge**: Cloudflare WAF rate limiting on
   `/api/session`, block or challenge the abusing ASN or country (datacenter
   ASNs first), Bot Fight Mode. Turnstile already guards new sessions.
5. **Shrink the open hours** (`staffed_hours`) to the window you can staff.
6. **Stop new sessions** (`new_sessions_enabled` off): people already in keep
   going, nobody new joins.
7. **Close matching** (`matching_enabled` off): the kill switch. Existing
   peer-to-peer calls continue; nobody is matched. Use it when the queue
   cannot be kept safe.
8. **Preserve evidence** under the retention rules. If any report involves a
   minor, follow the CSAM runbook.
9. **Reopen in reverse order** and watch the same signals for an hour.
10. **Write it down**: what happened, numbers, what you changed. If a stop
    rule fired (LB-16), record the change in `docs/safety-decision-log.md`
    before reopening.

## Stop rules (LB-16, decided in advance)

- Any confirmed CSAM incident: pause the affected pool and follow the CSAM runbook.
- The queue misses a legal clock twice in a week: shrink the staffed window.
- A regulator, police or court notice about child safety: `new_sessions_enabled` off, call the lawyer before replying.
- Nobody can staff the queue tonight: close for the night (`matching_enabled` off or empty the staffed window).
