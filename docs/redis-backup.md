# Redis backup and restore

Redis holds the operator flags (kill switch, staffed hours, blocklist),
sessions and age-gate outcomes, restrictions, reports metadata, appeals,
takedown tickets, the audit log, coins and friends. It runs with append-only
persistence (AOF) on the `redis-data` volume. A lost volume or a bad write
needs a snapshot from outside the host, so take one every night.

Report evidence is NOT in Redis: it lives on the `evidence-data` volume (or in
S3 when `EVIDENCE_S3_BUCKET` is set). Back up that volume separately if you
use it, and keep the copy under the same retention rules (docs/retention.md).

## Nightly backup

`scripts/backup-redis.sh` (the deploy copies it to `scripts/` on the host):

1. `BGSAVE` inside the redis container (the password stays in the container),
   then waits until the snapshot finished and succeeded.
2. Copies the RDB to `backups/redis/redis-<UTC time>.rdb` (mode 600) and
   checks it starts with the RDB magic bytes.
3. When `BACKUP_S3_URI` is set (in the environment or `.env`), uploads it with
   `aws s3 cp --sse AES256` (or `BACKUP_S3_SSE=aws:kms`).
4. Keeps the newest `BACKUP_KEEP` (7) local copies.

Cron on the host (as the deploy user, which can run docker):

```sh
crontab -e
15 3 * * * cd ~/Omegle_with_stun && mkdir -p backups && bash scripts/backup-redis.sh >> backups/redis-backup.log 2>&1
```

S3 setup (owner, once):

- A bucket in `ap-south-1` with public access blocked, default encryption on,
  versioning on, and a lifecycle rule that expires `redis-*.rdb` objects after
  35 days (the snapshot contains report metadata and restrictions, so do not
  keep it longer than docs/retention.md allows; 35 days covers a month of
  restores).
- The EC2 instance role gets `s3:PutObject` on `arn:aws:s3:::<bucket>/<prefix>/*`
  only. Restoring from S3 needs `s3:GetObject`; grant it temporarily.
- Set the `BACKUP_S3_URI` GitHub secret (for example `s3://chizzy-backups/redis`);
  the deploy writes it into `.env`.
- Install the AWS CLI on the host.

## Restore

Restoring is an outage: the backend stops (live calls drop) while Redis is
replaced. Post a banner first if the site is up.

```sh
cd ~/Omegle_with_stun
ls backups/redis/                                   # or: aws s3 ls s3://chizzy-backups/redis/
bash scripts/restore-redis.sh backups/redis/redis-20261004T031500Z.rdb --yes
# or straight from S3:
bash scripts/restore-redis.sh s3://chizzy-backups/redis/redis-20261004T031500Z.rdb --yes
```

What the script does, and why:

1. Stops the backend (no writes during the restore) and Redis.
2. In a one-off container on the same volume: moves the current
   `appendonlydir/` and `dump.rdb` aside as `*.before-restore-<time>`
   (nothing is deleted), and puts the snapshot in as `dump.rdb`.
3. Starts Redis with **AOF off** so it loads the snapshot. With AOF on and no
   AOF files, Redis 7 starts EMPTY and ignores `dump.rdb`; we tested this on
   2026-10-04, it is the trap this step avoids.
4. Turns AOF on (`CONFIG SET appendonly yes`), which rewrites the AOF from the
   restored data, waits for the rewrite to succeed, and shuts down cleanly.
5. Starts the whole stack (`docker compose up -d --wait`) and prints the key
   count.

Tested on 2026-10-04 with a 500-key dataset behind a Redis password: three
backups (pruned to two), flush, restore, all keys back, and the data
survived a second Redis restart (so the rebuilt AOF holds it).

If the script fails half way, Redis is stopped and the old files are still
in the volume. To go back to the state before the restore:

```sh
docker compose run --rm --no-deps --entrypoint sh redis -c '
  cd /data && rm -rf appendonlydir dump.rdb &&
  mv appendonlydir.before-restore-* appendonlydir && mv dump.rdb.before-restore-* dump.rdb'
docker compose up -d --wait
```

Once the restored data looks right, remove the `*.before-restore-*` files the
same way (they hold the data you replaced).

## Test it

Run one restore on staging before launch and after any Redis upgrade
(LAUNCH_PLAN LB-12: "a nightly Redis BGSAVE to S3, with one restore tested").
