# Runbook: cyber security incident (CERT-In 6 hour report)

Owner: the owner. Second person: the lawyer (for notices to users and regulators).
Sources: LAUNCH_PLAN LB-12, LB-16; research 04-trust-safety-legal.md section 4.1 (CERT-In Directions, April 2022).
**Not legal advice.** Confirm the current reporting form and address on https://www.cert-in.org.in before launch.

## Clock

**Report to CERT-In within 6 hours of noticing** a reportable incident. The
clock starts when you notice, not when you finish investigating. Send what you
know; update later.

## Is it reportable?

The CERT-In Directions list incident types. The ones that can happen to
Chizzy include:

- unauthorised access to the host, the admin console, Redis or an S3 bucket;
- a data breach or leak (sessions, reports, evidence, logs, backups);
- compromise of the server (malicious code, a crypto miner, a web shell);
- website defacement or a malicious script served to users;
- denial of service that takes the site down (DDoS);
- identity theft, spoofing or phishing that uses Chizzy's name or domain;
- attacks on the cloud account (AWS, Cloudflare, GitHub) or its keys.

When in doubt, report.

## Steps

1. **Note the time** you noticed and start a timeline (a plain text file,
   UTC and IST times).
2. **Contain without destroying evidence.**
   - Leaked secret: rotate it now (ADMIN_TOKEN, SESSION_SECRET via
     SESSION_SECRET_PREVIOUS, Cloudflare tokens, AWS keys, GitHub secrets,
     Docker Hub token), then redeploy.
   - Compromised host: in the AWS console, snapshot the EBS volume first,
     then isolate the instance (security group with no inbound rules) and
     deploy to a fresh instance (docs/runbooks/host-down.md).
   - Admin console abuse: clear `ADMIN_TOKEN` (admin API off) and redeploy;
     check the audit log in Redis for actions you did not take.
   - DDoS: Cloudflare "Under Attack" mode, rate limiting rules; the kill
     switch flags if the backend is overwhelmed.
3. **Preserve logs.** Copy `docker compose logs` for every service, the host
   auth log (`/var/log/auth.log`), Cloudflare and AWS CloudTrail events for
   the window. Logs must already be kept 180 days in India (see the retention
   table); do not let rotation delete the window you need: copy it now.
4. **Report to CERT-In within 6 h**: the incident reporting form on
   https://www.cert-in.org.in, or email `incident@cert-in.org.in` (verify the
   address on the site). Include: organisation and contact, time noticed,
   incident type, systems affected, what you have done so far. Keep the
   acknowledgement.
5. **Users and others.** If personal data leaked, the lawyer decides on
   notices to users and to the Data Protection Board (DPDP breach notification
   applies from the DPDP Rules phase 3, May 2027, but notify earlier if the
   lawyer advises). If the incident involved CSAM or a child, also follow the
   CSAM runbook.
6. **Status page.** Post on the Better Stack status page and the in-app
   banner (`banner_message` flag) in plain words. No speculation.
7. **Postmortem** within a week: timeline, impact, root cause, fix, follow
   ups. Add a line to `docs/safety-decision-log.md` if a safety choice
   changed.

## Prerequisites (launch checklist)

- Clocks synced with NTP (Ubuntu's `systemd-timesyncd` is on by default;
  CERT-In names NIC and NPL time servers, the lawyer confirms whether AWS's
  Time Sync Service is acceptable).
- Logs shipped to an India-region store with 180 days retention. **Not built
  yet**: container logs on the host rotate at 10 MB x 3 files.
