# Runbook: non-consensual intimate imagery (NCII) takedown

Owner: the on-duty reviewer. Escalation: the owner, then the lawyer.
Sources: LAUNCH_PLAN LB-1, LB-5, LB-16; research 04-trust-safety-legal.md sections 4.1 and 4.4.
**Not legal advice.**

## Clocks (the strictest one wins)

| Rule | Deadline | Applies to |
|---|---|---|
| IT Rules 2021 Rule 3(2)(b) | **24 h** from the complaint | Intimate images, sexual acts or impersonation, complaint from the affected person or someone on their behalf |
| US TAKE IT DOWN Act | **48 h** from a valid request, plus reasonable efforts to remove known identical copies | NCII on covered platforms (FTC enforcement since 19 May 2026) |
| IT Rules 2021 (2022 amendment) | 72 h | Other obscene or privacy-invasive content complaints |
| Grievance Officer | Acknowledge in 24 h, resolve in 15 days | Every complaint |

The `/admin` takedown timer shows the 48 h US clock. **Work to 24 h** for any
NCII complaint, because the Indian rule is shorter and applies to every
complaint Chizzy receives.

## Where NCII can exist on Chizzy

Calls are not recorded, so most notices concern:

- an evidence frame attached to a report (stored, restricted to reviewers);
- a profile photo shown to partners (kept for everyone by owner decision);
- a display name or chat line (only stored when attached to a report).

A recording made by another user with screen capture is not on Chizzy's
systems. Chizzy cannot remove it from other sites; point the person to
StopNCII.org (adults) or NCMEC's Take It Down service (images taken when the
person was under 18), and to https://cybercrime.gov.in or helpline 1930 in
India.

## Steps

1. **Acknowledge** within 24 h by email to the contact address on the ticket
   (template below). The ticket id is in `/admin` -> Takedowns.
2. **If the notice says the person in the image is or was a minor**, stop and
   switch to the CSAM runbook (docs/runbooks/csam-escalation.md).
3. **Find the content** using the ticket's location field (time, display
   name, description). Search reports around that time in `/admin`. Do not
   unblur evidence unless you need it to match the description.
4. **Remove**:
   - A profile photo lives only in the user's live session. Restrict the user
     showing it (`restrict`, reason `harassment` or `other`, a human decision
     on duration); the photo is no longer shown to anyone.
   - An evidence frame: the v1 console has no "delete evidence" action. Delete
     the file for that report id from the evidence store by hand (the
     `evidence-data` volume, or the S3 bucket when `EVIDENCE_S3_BUCKET` is
     set) unless it is under a CSAM hold, and write the report id and time in
     the ticket.
   - Record exactly what was removed in the ticket resolution.
5. **Identical copies**: check other reports from the same device or with the
   same evidence hash and remove them too.
6. **Resolve** the ticket with a short factual resolution and email the
   requester: what was found, what was removed, when.
7. **Nothing found**: tell the requester within the same clock, explain that
   calls are not recorded, and give the StopNCII, Take It Down and NCRP
   pointers above.
8. **Abuse of the form**: a notice in bad faith (targeting a user who did
   nothing) is still answered; do not restrict anyone without matching
   content.

## Templates

- Acknowledgement: "We received your request <ticket id> on <date>. We are
  reviewing it now and will act within 24 hours."
- Done: "We found and removed <what> on <date and time UTC>. The account that
  shared it can no longer use Chizzy <for duration>."
- Not found: "We could not find content matching your request. Chizzy does not
  record calls, so a recording made by someone else is not stored by us. You
  can ..." (pointers above).
