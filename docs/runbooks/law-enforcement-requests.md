# Runbook: law-enforcement requests and government orders

Owner: the owner (Grievance Officer). Second person on every disclosure: the lawyer.
Sources: LAUNCH_PLAN LB-4 ("Other legal clocks"); research 04-trust-safety-legal.md sections 4.1 and 11.
**Not legal advice.** LAWYER confirms the process and templates before launch.

## Clocks

| Request | Deadline | Source |
|---|---|---|
| Court order or government notice to remove or disable access to content (including Sahyog portal orders) | 36 h | IT Rules 2021 Rule 3(1)(d), amended Oct 2025 |
| Information or assistance for an authorised agency under a lawful order | 72 h | IT Rules 2021 Rule 3(1)(j) |
| Emergency: risk of death or serious injury | Immediately (call back the requesting unit, verify, then act) | research 04 section 11 |
| Preserve records named in an order | As ordered; 180 days minimum for removed content and records | IT Rules 3(1)(g) |

## Intake

- Requests arrive at `lawenforcement@` (and sometimes `grievance@` or `legal@`).
  Forward everything to `lawenforcement@` so there is one log.
- Log every request in the request log (a private spreadsheet the owner
  keeps): received time, requesting officer and unit, rank, legal provision
  cited, what is asked, deadline, response, response time, who approved.
- Valid Indian orders must name the issuing officer's rank and the legal
  provision (BNSS s.94, IT Act s.69 or 69B, IT Rules 3(1)(d) or 3(1)(j)).
  Since Oct 2025 takedown notices come from officers of Joint Secretary or DIG
  rank. If those details are missing, ask for them in writing; do not ignore
  the request.
- Foreign requests (US subpoenas and similar) usually arrive through MLAT or
  CLOUD Act routes. LAWYER decides every foreign request.

## What Chizzy can hand over

Chizzy does not record calls or store chat. What may exist, depending on the
retention table (docs/retention.md):

- Connection and match logs (IP address, time, pseudonymous device id), kept
  for 180 days.
- Reports, evidence frames attached by reporters, report chat lines, appeal
  and restriction records.
- Session and age-gate outcomes (over 18, ToS version, time). The date of
  birth is never stored.

Say plainly in the response what does not exist (video, audio, chat outside
reports).

## Steps

1. **Verify** the request is genuine: call the unit back on a number you look
   up yourself, not one in the email.
2. **Emergency path** (risk to life, a child in danger): act first on
   containment (restrict the device in `/admin`), give the officer what they
   need to act, and tell the lawyer the same day.
3. **Takedown order (36 h):** apply the restriction or removal in `/admin`,
   reply with what was done and when. Restrictions and evidence holds are in
   the audit log.
4. **Information request (72 h):** pull only the records named in the order.
   Two-person rule: the lawyer reviews every disclosure before it goes out.
   Send by the channel the order specifies; keep a copy of exactly what was
   sent.
5. **User notice:** tell the affected user unless the order or the law
   forbids it or it would put someone at risk. LAWYER decides.
6. **Close** the log entry with the response time.

## Templates (LAWYER to finalise)

- Acknowledgement: "We received your request dated <date>, reference <ref>.
  We are reviewing it and will respond by <deadline>."
- Records do not exist: "Chizzy does not record video, audio or chat. We hold
  no <records> for the identifiers in your request."
