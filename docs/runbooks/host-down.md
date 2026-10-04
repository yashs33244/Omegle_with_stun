# Runbook: host down

Owner: the owner.
Sources: LAUNCH_PLAN LB-11, LB-12; research 05-tech-launch.md section 11; DEPLOYMENT.md.

Production is one EC2 host running Docker Compose behind Cloudflare. If the
host is down, nobody can match; calls already connected peer to peer may
continue until someone presses Next.

## First 10 minutes

1. **Confirm**: Better Stack monitors, `https://<api>/healthz`, the canary
   workflow. Check https://www.cloudflarestatus.com and the AWS Health
   Dashboard: is it Cloudflare, AWS or us?
2. **Status page**: post "Investigating" on the Better Stack status page.
3. **EC2 console**: instance state and status checks. Auto-recovery should
   restart a failed system check by itself. If the instance is stopped or
   impaired, try a reboot once.
4. **On the host** (if SSH works):
   ```sh
   cd ~/Omegle_with_stun
   docker compose ps
   docker compose logs --tail=100 backend gateway redis
   df -h; free -m
   ```
   Common causes: disk full (old images: `docker image prune`, keep the
   current and previous tags), Redis out of memory, a bad deploy (roll back:
   `bash deploy/deploy.sh <previous sha>` from `.deployed-tag` history or
   re-run an older Deploy workflow).

## Rebuild on a fresh instance

1. Launch a new instance from the launch template (or the AMI), same security
   group, same instance role, IMDSv2 hop limit 2.
2. Install the host prerequisites (DEPLOYMENT.md), create the project
   directory.
3. Point the `EC2_HOST` secret at the new instance and run the Deploy workflow
   (`workflow_dispatch`). It writes `.env` from the secrets and starts the
   stack.
4. Restore Redis from the newest S3 snapshot (docs/redis-backup.md):
   ```sh
   bash scripts/restore-redis.sh s3://<bucket>/redis/redis-<newest>.rdb --yes
   ```
   Without it the flags fall back to defaults (check `staffed_hours`,
   `blocked_countries`, the banner) and restrictions, reports and appeals
   since the last snapshot are lost: re-check the queue.
5. Evidence on the old `evidence-data` volume: attach the old EBS volume and
   copy it over if the instance is not coming back (S3 evidence is not
   affected).
6. In Cloudflare DNS, point both proxied records at the new IP. The change is
   quick because the records are proxied.
7. Run the canary workflow by hand and make one real call.
8. Status page: "Resolved", with a short note.

## Afterwards

Postmortem within a week (timeline, impact, cause, fix). If the outage hid
reports past a legal clock, note it and tell the lawyer.
