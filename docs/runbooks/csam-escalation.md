# Runbook: suspected child sexual abuse material (CSAM) or a child at risk

Owner: the on-duty reviewer (owner or backup reviewer). Second person: the lawyer.
Sources: LAUNCH_PLAN LB-4 and LB-16; research 04-trust-safety-legal.md sections 4.1, 4.4, 6 and 11.
**Not legal advice.** The lawyer confirms every step marked LAWYER before launch.

## The rules that never bend

- **Do not open, view, download, copy or forward the image.** Possession is
  lawful only for reporting and preservation. Work from metadata, the
  classifier score and the report packet. The console never shows restricted
  evidence; do not try to get around that.
- **Do not tip off the suspect.** The restriction copy stays generic. Do not
  message the reported user about the reason.
- **Do not delete anything** connected to the report. Evidence is frozen for
  1 year by the escalate action. The hold ends by itself after that year and
  the retention sweep then deletes the report: if police or NCMEC ask for
  longer, escalate again before the date (each escalation renews the year).
  Release a hold early only when the lawyer confirms the process is closed
  (`POST /admin/api/reports/:id/release-hold`, audited; docs/retention.md).
- **Never decide "looks old enough" by eye.** An age pause is only lifted by
  verification (v1.1), never by a reviewer's impression.

## Clocks

| Clock | Deadline | Source |
|---|---|---|
| A child is in danger right now | Immediately: police 112 (India) or local emergency number | IT Rules / common sense; research 04 section 11 |
| Report to Indian police (SJPU or local police, or NCRP portal) | As soon as you know; do not wait for the NCMEC report | POCSO s.19 and s.20; Just Rights for Children Alliance v. S. Harish (SC, 2024) |
| Report to NCMEC CyberTipline | As soon as reasonably possible | 18 U.S.C. 2258A (LAWYER: how it binds an Indian operator) |
| Act on a complaint about child sexual content | 72 h from the complaint | IT Rules 2021 as amended 2022 |
| Preserve the evidence and report metadata | 1 year from the report (REPORT Act); 180 days minimum (IT Rules 3(1)(g)) | REPORT Act, Pub. L. 118-59 |

## Triggers

Any of these routes a report to the restricted store and to this runbook:

- A report with reason `underage` (Minor) that includes an evidence frame.
- Any evidence frame where the NSFW classifier fires and the report reason or
  the reported device's `minor_risk` signal points to a minor.
- A takedown ticket of kind `csam`.
- Anything a reviewer reads in the chat lines or report details that
  describes sexual content involving a child.

## Steps

1. **Contain (minutes).** In `/admin`, open the report. The reported device is
   already paused if the report was corroborated (LB-2). If it is not, apply a
   restriction now: action `restrict`, reason `minor-safety`, duration
   permanent (a human decision). This ends any call and blocks matching.
2. **Danger now?** If the chat lines or details suggest a child is being
   harmed or is about to meet someone, call **112** (India) first, give the
   time, the city if known and the report id. For a user outside India, the
   local emergency number; for the US, 911. Write down the call time and
   the officer's name.
3. **Escalate.** Action `escalate_csam` on the report. This freezes the
   evidence for 1 year, records the action in the audit log and produces the
   report packet (JSON: report id, times, reason, classifier score, whether a
   human viewed the file, pseudonymous device id, IP address and country at
   the time, evidence SHA-256, chat lines). Download the packet. Do not
   download the image.
4. **Report to Indian police (POCSO s.19).** File on https://cybercrime.gov.in
   ("Report Women/Child Related Crime", the CSAM reporting option) with the
   packet facts, or go to the local police or the Special Juvenile Police
   Unit. Keep the acknowledgement number. LAWYER: whether to transmit the
   frame itself and how (the police will tell you what they need; do not
   attach it on your own).
5. **Report to NCMEC CyberTipline.** Through the ESP reporting portal once
   Chizzy is registered (launch checklist), otherwise the public form at
   https://report.cybertip.org. Use the packet fields. Mark whether a human
   viewed the file (it should say no). Keep the report number.
6. **Record.** In the report's note field in `/admin`: time of each step,
   police acknowledgement number, NCMEC report number, who did what. The
   audit log keeps the actions; the note keeps the external references.
7. **Two-person check.** Send the lawyer a short summary (report id, times,
   reference numbers, no image) within 24 h.
8. **Stop rule (LB-16).** A confirmed CSAM incident pauses the affected pool:
   set `matching_enabled` to off in the flags editor if the source is not
   contained, write down what got through and why, and reopen only after the
   fix is written down. Add an entry to `docs/safety-decision-log.md`.
9. **Look after yourself.** If you saw something by accident, stop reviewing
   for the day and talk to someone you trust. Do not review further LB-4 items
   that day.

## Dry run (before launch, LB-16 drill)

Use a harmless test image (a blank frame) submitted as an `underage` report on
staging. Go from report to packet without opening the file, file nothing
externally, and time each step. Record the result in the launch checklist.

## What this process cannot do

Live video is peer to peer and never stored, so hash matching (PhotoDNA, NCMEC
or IWF hash lists) is not possible on calls. Detection at launch is user
reports plus on-device classifiers only. Say so in the risk assessment.
