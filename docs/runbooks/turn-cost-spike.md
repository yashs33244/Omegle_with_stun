# Runbook: TURN cost spike

Owner: the owner.
Sources: LAUNCH_PLAN LB-8, LB-11, D2, OD-1; research 05-tech-launch.md sections 2 and 11.

## Background

Calls are peer to peer and cost nothing. Only relayed calls cost money:
Cloudflare Realtime TURN, 1,000 GB a month free, then $0.05/GB. A relayed
480p call-hour is about 0.77 GB, so about $0.04. "Hide my IP" forces every
call of that user through the relay, and two relaying peers can be metered
twice. The bitrate cap is set by the client and a modified client can ignore
it, so the server-side defences are the credential rules (TURN credentials
only in `call:start`, per matched call, 2 h TTL, per-device and per-IP hourly
caps) and the spend poller.

AWS Budgets cannot see this bill; it is on Cloudflare.

## Automatic steps (the spend poller)

The backend polls Cloudflare's GraphQL analytics every 15 minutes
(`CF_ACCOUNT_ID`, `CF_ANALYTICS_TOKEN`) and, at the daily thresholds, steps
down in this order, alerting at each step:

1. lower `relay_video_max_kbps`;
2. turn off `private_mode_enabled` (Hide my IP);
3. turn off `turn_enabled` and set a banner.

## Manual steps

1. **Look**: Cloudflare dashboard -> Realtime -> TURN -> usage for today and
   the last 7 days. Compare with the share of `private` calls and the relayed
   share in `chizzy_calls_total{candidate_type="relay"}` on `/metrics`.
2. **Normal growth or abuse?** Abuse looks like a few devices or IPs with many
   credential sets or very long relayed calls. Check the backend logs for the
   per-device and per-IP credential cap being hit.
3. **Step down by hand** in `/admin` -> Flags, in this order, waiting 15
   minutes between steps to see the effect:
   - `relay_video_max_kbps` from 500 to 300;
   - `private_mode_enabled` off;
   - `turn_enabled` off, with `banner_message` "Some connections may fail on
     restrictive networks right now." Calls on networks that need a relay
     will fail until it is back on; that is the trade.
4. **Abusive devices or IPs**: restrict the devices; add a Cloudflare WAF rule
   for the IPs or ASN if it is a datacenter range.
5. **Rotate the TURN key** (Cloudflare -> Realtime -> TURN key -> new key;
   update `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` secrets; deploy) if
   credentials leaked outside calls.
6. **Turn things back on** in reverse order once usage is back to normal, and
   test one relayed call (the Playwright relay-forced test, or a call with
   Hide my IP on).
7. **Record** the spend, the cause and what you changed in the incident log.

## Before launch

- Set the daily thresholds from the monthly infra cap (OD-1, for example
  $100 a month) and test the full chain once on staging (LAUNCH_PLAN exit
  criteria).
- Set a Cloudflare billing notification as a second alarm.
