/**
 * Storage for coins, the coin ledger, premium unlocks, payment idempotency
 * keys and Razorpay orders.
 *
 * The balance itself stays where it always was, the MatchStore coins hash
 * (`getCoins`/`addCoins`), so coins earned in calls and coins bought with
 * Razorpay are one number. Both stores here are thin adapters over that
 * balance plus their own keys for the rest:
 *   - MemoryWalletStore: single instance and tests.
 *   - RedisWalletStore (prefix `chizzy:wallet:`):
 *       ledger:{deviceId}   list of JSON WalletLedgerEntry, newest first, capped; expires
 *                           WALLET_IDLE_TTL_MS after the last entry
 *       unlock:{deviceId}   hash feature -> expiresAt (epoch ms); expires WALLET_IDLE_TTL_MS
 *                           after the latest unlock lapses
 *       once:{key}          idempotency marker, kept CLAIM_TTL_MS (longer than any payment retry)
 *       order:{orderId}     JSON BillingOrderRecord; unpaid ones expire after UNPAID_ORDER_TTL_MS,
 *                           paid ones are kept for good (replays are decided from them)
 *       orders              zset orderId -> createdAt, capped
 *
 * Debits are "add a negative delta, undo if the result went below zero"; the
 * compensating add keeps a concurrent earn or credit intact (see
 * BillingService.debit).
 */
import type Redis from "ioredis";
import type { BillingOrderRecord, PremiumFeature, WalletLedgerEntry } from "../protocol";
import type { MatchStore } from "../store/MatchStore";

/** The MatchStore methods the wallet needs for the balance. */
export type CoinBalance = Pick<MatchStore, "getCoins" | "addCoins">;

/** Ledger entries kept per device. */
export const LEDGER_MAX = 200;
/** Orders kept for the admin list (the memory store also evicts unpaid orders past this). */
export const ORDERS_MAX = 2_000;
/**
 * How long (ms) an order that was never paid is kept. Checkout runs minutes
 * after the order is created, so a day is generous; without a bound, anyone
 * with a session could grow the order table forever. Paid orders never expire.
 */
export const UNPAID_ORDER_TTL_MS = 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/**
 * How long (ms) a credit claim (`once:` key) is kept. Razorpay retries a
 * webhook for about a day and a client can re-verify a payment for as long as
 * it keeps the ids, so two years is far past any replay of the same order.
 */
export const CLAIM_TTL_MS = 2 * 365 * DAY_MS;
/**
 * A device's ledger is dropped this long (ms) after its last entry, its
 * unlocks this long after the latest one lapsed. The balance lives in the
 * MatchStore coins hash and never expires.
 */
export const WALLET_IDLE_TTL_MS = 365 * DAY_MS;

export interface WalletStore {
  /** Stored balance, or null if the device never had coins. */
  getBalance(deviceId: string): Promise<number | null>;
  /** Atomically adds delta, starting from `initial` if unset. Returns the new balance. */
  addBalance(deviceId: string, delta: number, initial: number): Promise<number>;

  appendLedger(entry: WalletLedgerEntry): Promise<void>;
  /** Newest first. */
  listLedger(deviceId: string, limit: number): Promise<WalletLedgerEntry[]>;

  /** Expiry of the unlock (epoch ms), even if it has passed; null when never unlocked. */
  getUnlock(deviceId: string, feature: PremiumFeature): Promise<number | null>;
  setUnlock(deviceId: string, feature: PremiumFeature, expiresAt: number): Promise<void>;
  /** Atomically moves the expiry to max(now, current) + ms and returns it. */
  extendUnlock(deviceId: string, feature: PremiumFeature, ms: number, now: number): Promise<number>;
  listUnlocks(deviceId: string): Promise<Record<string, number>>;

  /** True the first time `key` is claimed; false for every later call within CLAIM_TTL_MS. */
  claimOnce(key: string): Promise<boolean>;
  /** Gives a claim back after the work it guarded failed, so a retry can credit. */
  releaseClaim(key: string): Promise<void>;

  /** Stores the order; an unpaid one is kept UNPAID_ORDER_TTL_MS, a paid one for good. */
  putOrder(order: BillingOrderRecord): Promise<void>;
  getOrder(orderId: string): Promise<BillingOrderRecord | null>;
  /** Newest first. */
  listOrders(limit: number): Promise<BillingOrderRecord[]>;
}

/** Lua moving the unlock hash's expiry to WALLET_IDLE_TTL_MS (in ARGV[idleArg]) after its latest unlock. */
const expireUnlocksLua = (idleArg: number) => `
local latest = 0
for _, v in ipairs(redis.call('HVALS', KEYS[1])) do
  local n = tonumber(v) or 0
  if n > latest then latest = n end
end
redis.call('PEXPIREAT', KEYS[1], latest + tonumber(ARGV[${idleArg}]))
`;

/** KEYS[1] unlock hash, ARGV[1] feature, ARGV[2] expiresAt, ARGV[3] idle ms. */
const SET_UNLOCK_LUA = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
${expireUnlocksLua(3)}
`;

/** KEYS[1] unlock hash, ARGV[1] feature, ARGV[2] ms, ARGV[3] now, ARGV[4] idle ms. Returns the new expiry. */
const EXTEND_UNLOCK_LUA = `
local current = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
local base = tonumber(ARGV[3])
if current > base then base = current end
local expires = base + tonumber(ARGV[2])
redis.call('HSET', KEYS[1], ARGV[1], tostring(expires))
${expireUnlocksLua(4)}
return expires
`;

export class MemoryWalletStore implements WalletStore {
  /** deviceId -> entries and when they expire (epoch ms). */
  private readonly ledger = new Map<string, { entries: WalletLedgerEntry[]; expiresAt: number }>();
  /** deviceId -> feature expiries and when the record expires (epoch ms). */
  private readonly unlocks = new Map<string, { features: Record<string, number>; expiresAt: number }>();
  /** claim key -> expiry (epoch ms). */
  private readonly claims = new Map<string, number>();
  /** Expired entries are swept when a map reaches this size; it then doubles, so sweeps stay amortized O(1). */
  private sweepAt = { ledger: 1_024, unlocks: 1_024, claims: 1_024 };
  private readonly orders = new Map<string, BillingOrderRecord>();
  /** orderId -> expiry (epoch ms) of every unpaid order, oldest first. */
  private readonly unpaid = new Map<string, number>();

  constructor(
    private readonly coins: CoinBalance,
    private readonly now: () => number = Date.now,
  ) {}

  getBalance(deviceId: string): Promise<number | null> {
    return this.coins.getCoins(deviceId);
  }

  addBalance(deviceId: string, delta: number, initial: number): Promise<number> {
    return this.coins.addCoins(deviceId, delta, initial);
  }

  async appendLedger(entry: WalletLedgerEntry): Promise<void> {
    const entries = this.live(this.ledger, entry.deviceId)?.entries ?? [];
    entries.unshift({ ...entry });
    if (entries.length > LEDGER_MAX) entries.length = LEDGER_MAX;
    this.ledger.set(entry.deviceId, { entries, expiresAt: this.now() + WALLET_IDLE_TTL_MS });
    this.sweep("ledger", this.ledger, (v) => v.expiresAt);
  }

  async listLedger(deviceId: string, limit: number): Promise<WalletLedgerEntry[]> {
    return (this.live(this.ledger, deviceId)?.entries ?? []).slice(0, limit).map((e) => ({ ...e }));
  }

  async getUnlock(deviceId: string, feature: PremiumFeature): Promise<number | null> {
    return this.live(this.unlocks, deviceId)?.features[feature] ?? null;
  }

  async setUnlock(deviceId: string, feature: PremiumFeature, expiresAt: number): Promise<void> {
    this.putUnlock(deviceId, feature, expiresAt);
  }

  async extendUnlock(deviceId: string, feature: PremiumFeature, ms: number, now: number): Promise<number> {
    const expiresAt = Math.max(now, this.live(this.unlocks, deviceId)?.features[feature] ?? 0) + ms;
    this.putUnlock(deviceId, feature, expiresAt);
    return expiresAt;
  }

  async listUnlocks(deviceId: string): Promise<Record<string, number>> {
    return { ...this.live(this.unlocks, deviceId)?.features };
  }

  /** Sets one feature; the record expires WALLET_IDLE_TTL_MS after its latest unlock, as in Redis. */
  private putUnlock(deviceId: string, feature: PremiumFeature, expiresAt: number): void {
    const features = { ...this.live(this.unlocks, deviceId)?.features, [feature]: expiresAt };
    this.unlocks.set(deviceId, { features, expiresAt: Math.max(...Object.values(features)) + WALLET_IDLE_TTL_MS });
    this.sweep("unlocks", this.unlocks, (v) => v.expiresAt);
  }

  /** The record under `key` unless it has expired (then it is deleted). */
  private live<V extends { expiresAt: number }>(map: Map<string, V>, key: string): V | undefined {
    const value = map.get(key);
    if (value && value.expiresAt <= this.now()) {
      map.delete(key);
      return undefined;
    }
    return value;
  }

  private sweep<V>(name: keyof MemoryWalletStore["sweepAt"], map: Map<string, V>, expiresAt: (value: V) => number): void {
    if (map.size < this.sweepAt[name]) return;
    const now = this.now();
    for (const [key, value] of map) if (expiresAt(value) <= now) map.delete(key);
    this.sweepAt[name] = Math.max(1_024, map.size * 2);
  }

  async claimOnce(key: string): Promise<boolean> {
    const now = this.now();
    if ((this.claims.get(key) ?? 0) > now) return false;
    this.claims.set(key, now + CLAIM_TTL_MS);
    this.sweep("claims", this.claims, (v) => v);
    return true;
  }

  async releaseClaim(key: string): Promise<void> {
    this.claims.delete(key);
  }

  async putOrder(order: BillingOrderRecord): Promise<void> {
    this.orders.set(order.orderId, { ...order });
    if (order.status === "paid") this.unpaid.delete(order.orderId);
    else this.unpaid.set(order.orderId, this.now() + UNPAID_ORDER_TTL_MS);
    if (this.orders.size > ORDERS_MAX) this.evict();
  }

  async getOrder(orderId: string): Promise<BillingOrderRecord | null> {
    const expiresAt = this.unpaid.get(orderId);
    if (expiresAt !== undefined && expiresAt <= this.now()) {
      this.drop(orderId);
      return null;
    }
    const order = this.orders.get(orderId);
    return order ? { ...order } : null;
  }

  /** Expired unpaid orders go first, then the oldest unpaid ones; a paid order is money and is never evicted. */
  private evict(): void {
    const now = this.now();
    for (const [orderId, expiresAt] of this.unpaid) if (expiresAt <= now) this.drop(orderId);
    for (const orderId of this.unpaid.keys()) {
      if (this.orders.size <= ORDERS_MAX) break;
      this.drop(orderId);
    }
  }

  private drop(orderId: string): void {
    this.orders.delete(orderId);
    this.unpaid.delete(orderId);
  }

  async listOrders(limit: number): Promise<BillingOrderRecord[]> {
    const now = this.now();
    return [...this.orders.values()]
      .filter((o) => (this.unpaid.get(o.orderId) ?? Infinity) > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((o) => ({ ...o }));
  }
}

export class RedisWalletStore implements WalletStore {
  constructor(
    private readonly coins: CoinBalance,
    private readonly redis: Redis,
    private readonly prefix = "chizzy:wallet:",
  ) {}

  getBalance(deviceId: string): Promise<number | null> {
    return this.coins.getCoins(deviceId);
  }

  addBalance(deviceId: string, delta: number, initial: number): Promise<number> {
    return this.coins.addCoins(deviceId, delta, initial);
  }

  async appendLedger(entry: WalletLedgerEntry): Promise<void> {
    const key = `${this.prefix}ledger:${entry.deviceId}`;
    await this.redis.multi().lpush(key, JSON.stringify(entry)).ltrim(key, 0, LEDGER_MAX - 1).pexpire(key, WALLET_IDLE_TTL_MS).exec();
  }

  async listLedger(deviceId: string, limit: number): Promise<WalletLedgerEntry[]> {
    const raw = await this.redis.lrange(`${this.prefix}ledger:${deviceId}`, 0, limit - 1);
    return raw.map((s) => JSON.parse(s) as WalletLedgerEntry);
  }

  async getUnlock(deviceId: string, feature: PremiumFeature): Promise<number | null> {
    const raw = await this.redis.hget(`${this.prefix}unlock:${deviceId}`, feature);
    return raw === null ? null : Number(raw);
  }

  async setUnlock(deviceId: string, feature: PremiumFeature, expiresAt: number): Promise<void> {
    await this.redis.eval(SET_UNLOCK_LUA, 1, `${this.prefix}unlock:${deviceId}`, feature, String(expiresAt), String(WALLET_IDLE_TTL_MS));
  }

  async extendUnlock(deviceId: string, feature: PremiumFeature, ms: number, now: number): Promise<number> {
    const result = await this.redis.eval(
      EXTEND_UNLOCK_LUA,
      1,
      `${this.prefix}unlock:${deviceId}`,
      feature,
      String(ms),
      String(now),
      String(WALLET_IDLE_TTL_MS),
    );
    return Number(result);
  }

  async listUnlocks(deviceId: string): Promise<Record<string, number>> {
    const raw = await this.redis.hgetall(`${this.prefix}unlock:${deviceId}`);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = Number(v);
    return out;
  }

  async claimOnce(key: string): Promise<boolean> {
    const res = await this.redis.set(`${this.prefix}once:${key}`, "1", "PX", CLAIM_TTL_MS, "NX");
    return res === "OK";
  }

  async releaseClaim(key: string): Promise<void> {
    await this.redis.del(`${this.prefix}once:${key}`);
  }

  async putOrder(order: BillingOrderRecord): Promise<void> {
    const key = `${this.prefix}order:${order.orderId}`;
    const index = `${this.prefix}orders`;
    const json = JSON.stringify(order);
    // A plain SET drops any TTL left from the unpaid record, so a paid order is kept for good.
    const tx = order.status === "paid" ? this.redis.multi().set(key, json) : this.redis.multi().set(key, json, "PX", UNPAID_ORDER_TTL_MS);
    await tx.zadd(index, order.createdAt, order.orderId).zremrangebyrank(index, 0, -ORDERS_MAX - 1).exec();
  }

  async getOrder(orderId: string): Promise<BillingOrderRecord | null> {
    const raw = await this.redis.get(`${this.prefix}order:${orderId}`);
    return raw === null ? null : (JSON.parse(raw) as BillingOrderRecord);
  }

  async listOrders(limit: number): Promise<BillingOrderRecord[]> {
    const ids = await this.redis.zrevrange(`${this.prefix}orders`, 0, limit - 1);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => `${this.prefix}order:${id}`));
    return raws.flatMap((raw) => (raw === null ? [] : [JSON.parse(raw) as BillingOrderRecord]));
  }
}
