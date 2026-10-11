/**
 * MatchStore on Redis, shared by every backend instance.
 *
 * Keys (all under the prefix, default `chizzy:`):
 *   session:{socketId}         JSON Session
 *   sessions                   set of all session socketIds (for stats)
 *   photo:{socketId}           profile photo data URL
 *   device:{deviceId}          socketId of the device's live session
 *   waiting                    zset socketId -> waitingSince
 *   room:{roomId}              JSON Room (pending rooms carry a safety-net TTL)
 *   rooms:pending              zset roomId -> expiresAt
 *   rooms:active               set of active room ids (for stats)
 *   coins                      hash deviceId -> balance
 *   friends:{deviceId}         set of friend deviceIds
 *   block:{devLow}:{devHigh}   JSON PairBlock (TTL = retain time)
 *   reports                    list of JSON ReportRecord, newest last, capped
 *   reportsAgainst:{deviceId}  zset reporterDevice -> latest report ts
 *   ban:{deviceId}             ban expiry (epoch ms), expires itself
 *   instances                  set of instance ids that sent a heartbeat
 *   instance:{id}              heartbeat (TTL)
 *   instanceSessions:{id}      set of socketIds owned by the instance
 *   lock:match                 the matchmaking lock token
 *
 * The lock is a lease: SET NX PX with a random token, released by a Lua
 * compare-and-delete so an instance never deletes a lock it no longer holds.
 * Callers in one process queue locally first, so only one of them polls Redis.
 *
 * Instance liveness is "instance:{id} exists". A Redis outage longer than the
 * TTL expires every heartbeat, live or not. So once this client loses Redis
 * (connection closed or a heartbeat failed), listDeadInstances() reports
 * nothing until a full TTL after its next successful heartbeat, which gives
 * peers that reconnect a little later the time to beat again. The store also
 * re-sends its last heartbeat as soon as the connection is ready again.
 */
import { randomUUID } from "node:crypto";
import Redis, { type ChainableCommander, type RedisOptions } from "ioredis";
import type { Logger } from "../logger";
import {
  LOCK_BACKOFF_MAX_MS,
  LOCK_BACKOFF_START_MS,
  LOCK_TTL_MS,
  LOCK_WAIT_MS,
  MATCH_KEY_PREFIX,
  PENDING_ROOM_GRACE_MS,
  REDIS_COMMAND_TIMEOUT_MS,
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_MAX_RETRIES_PER_REQUEST,
  REPORTS_AGAINST_TTL_MS,
  REPORT_LOG_MAX,
} from "./constants";
import {
  pairKey,
  type MatchStore,
  type PairBlock,
  type ReportRecord,
  type Room,
  type Session,
  type StoreStats,
} from "./MatchStore";

export interface RedisStoreOptions {
  /** Key prefix. Default MATCH_KEY_PREFIX; tests use a unique prefix per store. */
  prefix?: string;
  logger?: Logger;
  /** Lock lease. A critical section running longer than this is logged as an error. */
  lockTtlMs?: number;
  /**
   * withLock() rejects if the lock cannot be acquired within this time,
   * counted from the call: time queued behind earlier callers in this
   * process counts too, so a backlog sheds work instead of growing.
   */
  lockWaitMs?: number;
}

/** Client options shared by the store and the Socket.IO adapter clients. */
export const REDIS_CLIENT_OPTIONS: RedisOptions = {
  lazyConnect: true,
  connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
  maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
};

const COMPARE_AND_DELETE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LOCK_TIMEOUT = "timed out waiting for the match lock";

/** True if `p` resolves before `deadline` (epoch ms), false once the deadline passes. */
async function resolvesBefore(p: Promise<void>, deadline: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), deadline - Date.now())));
  try {
    return await Promise.race([p.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

const parse = <T>(raw: string | null): T | null => (raw === null ? null : (JSON.parse(raw) as T));

/** Runs a MULTI or pipeline and throws the first command error (exec() only reports them). */
async function run(batch: ChainableCommander): Promise<unknown[]> {
  const results = await batch.exec();
  if (!results) throw new Error("redis transaction aborted");
  return results.map(([err, value]) => {
    if (err) throw err;
    return value;
  });
}

export class RedisStore implements MatchStore {
  private readonly prefix: string;
  private readonly log?: Logger;
  private readonly lockTtlMs: number;
  private readonly lockWaitMs: number;
  private localTail: Promise<void> = Promise.resolve();
  /** The last heartbeat sent, re-sent when the connection comes back. */
  private lastBeat?: { instanceId: string; ttlMs: number };
  /** listDeadInstances() reports nothing before this time (Infinity until a beat succeeds after an outage). */
  private reapAllowedAt = 0;

  private constructor(
    private readonly redis: Redis,
    opts: RedisStoreOptions,
  ) {
    this.prefix = opts.prefix ?? MATCH_KEY_PREFIX;
    this.log = opts.logger;
    this.lockTtlMs = opts.lockTtlMs ?? LOCK_TTL_MS;
    this.lockWaitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
    redis.on("close", () => this.markOutage());
    redis.on("ready", () => {
      const beat = this.lastBeat;
      if (!beat) return;
      this.heartbeat(beat.instanceId, beat.ttlMs).catch((err: unknown) =>
        this.log?.warn({ err }, "heartbeat after reconnect failed"),
      );
    });
  }

  /** Connects and resolves once Redis answers; rejects (and gives up) if it cannot connect. */
  static async connect(url: string, opts: RedisStoreOptions = {}): Promise<RedisStore> {
    const redis = new Redis(url, {
      ...REDIS_CLIENT_OPTIONS,
      enableAutoPipelining: true,
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    });
    redis.on("error", (err) => opts.logger?.warn({ err }, "redis store connection error"));
    try {
      await redis.connect();
    } catch (err) {
      redis.disconnect();
      throw err;
    }
    return new RedisStore(redis, opts);
  }

  private key(...parts: string[]): string {
    return this.prefix + parts.join(":");
  }

  async ping(): Promise<void> {
    const reply = await this.redis.ping();
    if (reply !== "PONG") throw new Error(`unexpected PING reply: ${reply}`);
  }

  /* ---------------------------------------------------------------- */
  /* Lock                                                              */
  /* ---------------------------------------------------------------- */

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.lockWaitMs;
    const previous = this.localTail;
    let releaseLocal!: () => void;
    this.localTail = new Promise<void>((resolve) => (releaseLocal = resolve));
    if (!(await resolvesBefore(previous, deadline))) {
      // Pass the slot on only once the caller ahead is done, so the next
      // local caller does not start polling Redis while that one still waits.
      void previous.then(releaseLocal);
      throw new Error(LOCK_TIMEOUT);
    }
    try {
      const token = randomUUID();
      await this.acquire(token, deadline);
      const started = Date.now();
      try {
        return await fn();
      } finally {
        await this.release(token, Date.now() - started);
      }
    } finally {
      releaseLocal();
    }
  }

  private async acquire(token: string, deadline: number): Promise<void> {
    const lockKey = this.key("lock", "match");
    let backoff = LOCK_BACKOFF_START_MS;
    for (;;) {
      if ((await this.redis.set(lockKey, token, "PX", this.lockTtlMs, "NX")) === "OK") return;
      // ioredis re-sends a command whose reply was lost in a reconnect, and
      // the re-sent SET NX answers null when the first one already took the lock.
      if ((await this.redis.get(lockKey)) === token) return;
      if (Date.now() >= deadline) throw new Error(LOCK_TIMEOUT);
      // Equal jitter: wait between backoff/2 and backoff ms, growing to the cap.
      await sleep(backoff / 2 + Math.random() * (backoff / 2));
      backoff = Math.min(backoff * 2, LOCK_BACKOFF_MAX_MS);
    }
  }

  private async release(token: string, heldMs: number): Promise<void> {
    let released = false;
    try {
      released = (await this.redis.eval(COMPARE_AND_DELETE, 1, this.key("lock", "match"), token)) === 1;
    } catch (err) {
      // The lease expires by itself; never mask the critical section's result.
      this.log?.error({ err }, "failed to release the match lock");
      return;
    }
    if (!released || heldMs >= this.lockTtlMs) {
      this.log?.error(
        { heldMs, lockTtlMs: this.lockTtlMs },
        "match lock lease expired before release; another instance may have entered the critical section",
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Sessions and photos                                               */
  /* ---------------------------------------------------------------- */

  async getSession(socketId: string): Promise<Session | null> {
    return parse<Session>(await this.redis.get(this.key("session", socketId)));
  }

  async getSessions(socketIds: string[]): Promise<(Session | null)[]> {
    if (socketIds.length === 0) return [];
    const raws = await this.redis.mget(socketIds.map((id) => this.key("session", id)));
    return raws.map((raw) => parse<Session>(raw));
  }

  async putSession(session: Session): Promise<void> {
    await run(
      this.redis
        .multi()
        .set(this.key("session", session.socketId), JSON.stringify(session))
        .sadd(this.key("sessions"), session.socketId)
        .sadd(this.key("instanceSessions", session.instanceId), session.socketId),
    );
  }

  async deleteSession(socketId: string): Promise<void> {
    const existing = await this.getSession(socketId);
    const batch = this.redis
      .multi()
      .del(this.key("session", socketId))
      .srem(this.key("sessions"), socketId)
      .del(this.key("photo", socketId));
    if (existing) batch.srem(this.key("instanceSessions", existing.instanceId), socketId);
    await run(batch);
  }

  async setPhoto(socketId: string, photo: string | null): Promise<void> {
    if (photo === null) await this.redis.del(this.key("photo", socketId));
    else await this.redis.set(this.key("photo", socketId), photo);
  }

  async getPhoto(socketId: string): Promise<string | null> {
    return this.redis.get(this.key("photo", socketId));
  }

  /* ---------------------------------------------------------------- */
  /* Device binding                                                    */
  /* ---------------------------------------------------------------- */

  async getDeviceSocket(deviceId: string): Promise<string | null> {
    return this.redis.get(this.key("device", deviceId));
  }

  async setDeviceSocket(deviceId: string, socketId: string): Promise<void> {
    await this.redis.set(this.key("device", deviceId), socketId);
  }

  async clearDeviceSocket(deviceId: string, socketId: string): Promise<void> {
    await this.redis.eval(COMPARE_AND_DELETE, 1, this.key("device", deviceId), socketId);
  }

  /* ---------------------------------------------------------------- */
  /* Waiting queue                                                     */
  /* ---------------------------------------------------------------- */

  async addWaiting(socketId: string, since: number): Promise<void> {
    await this.redis.zadd(this.key("waiting"), since, socketId);
  }

  async removeWaiting(socketId: string): Promise<void> {
    await this.redis.zrem(this.key("waiting"), socketId);
  }

  async listWaiting(): Promise<string[]> {
    return this.redis.zrange(this.key("waiting"), 0, -1);
  }

  /* ---------------------------------------------------------------- */
  /* Rooms                                                             */
  /* ---------------------------------------------------------------- */

  async getRoom(roomId: string): Promise<Room | null> {
    return parse<Room>(await this.redis.get(this.key("room", roomId)));
  }

  async putRoom(room: Room): Promise<void> {
    const roomKey = this.key("room", room.id);
    const batch = this.redis.multi();
    if (room.state === "pending") {
      const ttl = Math.max(0, room.expiresAt - Date.now()) + PENDING_ROOM_GRACE_MS;
      batch
        .set(roomKey, JSON.stringify(room), "PX", ttl)
        .zadd(this.key("rooms", "pending"), room.expiresAt, room.id)
        .srem(this.key("rooms", "active"), room.id);
    } else {
      // A plain SET also clears the TTL the pending room had.
      batch
        .set(roomKey, JSON.stringify(room))
        .zrem(this.key("rooms", "pending"), room.id)
        .sadd(this.key("rooms", "active"), room.id);
    }
    await run(batch);
  }

  async deleteRoom(roomId: string): Promise<void> {
    await run(
      this.redis
        .multi()
        .del(this.key("room", roomId))
        .zrem(this.key("rooms", "pending"), roomId)
        .srem(this.key("rooms", "active"), roomId),
    );
  }

  async listExpiredPendingRooms(cutoff: number): Promise<string[]> {
    const pendingKey = this.key("rooms", "pending");
    const ids = await this.redis.zrangebyscore(pendingKey, "-inf", cutoff);
    if (ids.length === 0) return [];
    // Drop index entries whose room key is gone (only possible after the TTL).
    const exists = await run(this.redis.pipeline(ids.map((id) => ["exists", this.key("room", id)])));
    const live = ids.filter((_, i) => exists[i] === 1);
    const gone = ids.filter((_, i) => exists[i] !== 1);
    if (gone.length > 0) await this.redis.zrem(pendingKey, ...gone);
    return live;
  }

  /* ---------------------------------------------------------------- */
  /* Coins, friends, blocks                                            */
  /* ---------------------------------------------------------------- */

  async getCoins(deviceId: string): Promise<number | null> {
    const raw = await this.redis.hget(this.key("coins"), deviceId);
    return raw === null ? null : Number(raw);
  }

  async addCoins(deviceId: string, delta: number, initial: number): Promise<number> {
    const coinsKey = this.key("coins");
    const [, balance] = await run(
      this.redis.multi().hsetnx(coinsKey, deviceId, initial).hincrby(coinsKey, deviceId, delta),
    );
    return Number(balance);
  }

  async areFriends(deviceA: string, deviceB: string): Promise<boolean> {
    return (await this.redis.sismember(this.key("friends", deviceA), deviceB)) === 1;
  }

  async addFriends(deviceA: string, deviceB: string): Promise<void> {
    await run(
      this.redis.multi().sadd(this.key("friends", deviceA), deviceB).sadd(this.key("friends", deviceB), deviceA),
    );
  }

  async getBlock(deviceA: string, deviceB: string): Promise<PairBlock | null> {
    return parse<PairBlock>(await this.redis.get(this.key("block", pairKey(deviceA, deviceB))));
  }

  async setBlock(deviceA: string, deviceB: string, block: PairBlock, retainMs: number): Promise<void> {
    const ttl = Math.max(1, Math.ceil(retainMs));
    await this.redis.set(this.key("block", pairKey(deviceA, deviceB)), JSON.stringify(block), "PX", ttl);
  }

  /* ---------------------------------------------------------------- */
  /* Reports and bans                                                  */
  /* ---------------------------------------------------------------- */

  async addReport(report: ReportRecord): Promise<void> {
    const reportsKey = this.key("reports");
    const againstKey = this.key("reportsAgainst", report.reportedDevice);
    await run(
      this.redis
        .multi()
        .rpush(reportsKey, JSON.stringify(report))
        .ltrim(reportsKey, -REPORT_LOG_MAX, -1)
        // GT keeps the latest report time per reporter.
        .zadd(againstKey, "GT", report.ts, report.reporterDevice)
        .pexpire(againstKey, REPORTS_AGAINST_TTL_MS),
    );
  }

  async countReporters(deviceId: string, since: number): Promise<number> {
    const againstKey = this.key("reportsAgainst", deviceId);
    const [, count] = await run(
      this.redis.multi().zremrangebyscore(againstKey, "-inf", `(${since}`).zcard(againstKey),
    );
    return Number(count);
  }

  async getBan(deviceId: string): Promise<number | null> {
    const raw = await this.redis.get(this.key("ban", deviceId));
    if (raw === null) return null;
    const until = Number(raw);
    return until > Date.now() ? until : null;
  }

  async setBan(deviceId: string, until: number): Promise<void> {
    const banKey = this.key("ban", deviceId);
    if (until <= Date.now()) await this.redis.del(banKey);
    else await this.redis.set(banKey, String(until), "PXAT", until);
  }

  /* ---------------------------------------------------------------- */
  /* Instances                                                         */
  /* ---------------------------------------------------------------- */

  async heartbeat(instanceId: string, ttlMs: number): Promise<void> {
    this.lastBeat = { instanceId, ttlMs };
    try {
      await run(
        this.redis
          .multi()
          .set(this.key("instance", instanceId), String(Date.now()), "PX", Math.max(1, Math.ceil(ttlMs)))
          .sadd(this.key("instances"), instanceId),
      );
    } catch (err) {
      this.markOutage();
      throw err;
    }
    if (this.reapAllowedAt === Infinity) this.reapAllowedAt = Date.now() + ttlMs;
  }

  /** This client lost Redis, so peers' heartbeats may have lapsed through no fault of theirs. */
  private markOutage(): void {
    this.reapAllowedAt = Infinity;
  }

  async listDeadInstances(): Promise<string[]> {
    if (Date.now() < this.reapAllowedAt) return [];
    const ids = await this.redis.smembers(this.key("instances"));
    if (ids.length === 0) return [];
    const alive = await run(this.redis.pipeline(ids.map((id) => ["exists", this.key("instance", id)])));
    return ids.filter((_, i) => alive[i] !== 1);
  }

  async listInstanceSessions(instanceId: string): Promise<string[]> {
    return this.redis.smembers(this.key("instanceSessions", instanceId));
  }

  async forgetInstance(instanceId: string): Promise<void> {
    if (this.lastBeat?.instanceId === instanceId) this.lastBeat = undefined;
    await run(
      this.redis
        .multi()
        .srem(this.key("instances"), instanceId)
        .del(this.key("instanceSessions", instanceId))
        .del(this.key("instance", instanceId)),
    );
  }

  /* ---------------------------------------------------------------- */

  async stats(): Promise<StoreStats> {
    const [sessions, waiting, pendingRooms, activeRooms] = (await run(
      this.redis
        .pipeline()
        .scard(this.key("sessions"))
        .zcard(this.key("waiting"))
        .zcard(this.key("rooms", "pending"))
        .scard(this.key("rooms", "active")),
    )) as number[];
    return { sessions: sessions!, waiting: waiting!, pendingRooms: pendingRooms!, activeRooms: activeRooms! };
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
