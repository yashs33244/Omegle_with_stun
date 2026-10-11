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
 *       ledger:{deviceId}   list of JSON WalletLedgerEntry, newest first, capped
 *       unlock:{deviceId}   hash feature -> expiresAt (epoch ms)
 *       once:{key}          idempotency marker, kept for good (a payment id never un-happens)
 *       order:{orderId}     JSON BillingOrderRecord, kept for good (replays are decided from it)
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
/** Orders kept for the admin list. */
export const ORDERS_MAX = 2_000;

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

  /** True the first time `key` is claimed; false for every later call. Claims never expire. */
  claimOnce(key: string): Promise<boolean>;
  /** Gives a claim back after the work it guarded failed, so a retry can credit. */
  releaseClaim(key: string): Promise<void>;

  putOrder(order: BillingOrderRecord): Promise<void>;
  getOrder(orderId: string): Promise<BillingOrderRecord | null>;
  /** Newest first. */
  listOrders(limit: number): Promise<BillingOrderRecord[]>;
}

/** KEYS[1] unlock hash, ARGV[1] feature, ARGV[2] ms, ARGV[3] now. Returns the new expiry. */
const EXTEND_UNLOCK_LUA = `
local current = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
local base = tonumber(ARGV[3])
if current > base then base = current end
local expires = base + tonumber(ARGV[2])
redis.call('HSET', KEYS[1], ARGV[1], tostring(expires))
return expires
`;

export class MemoryWalletStore implements WalletStore {
  private readonly ledger = new Map<string, WalletLedgerEntry[]>();
  private readonly unlocks = new Map<string, Record<string, number>>();
  private readonly claims = new Set<string>();
  private readonly orders = new Map<string, BillingOrderRecord>();

  constructor(private readonly coins: CoinBalance) {}

  getBalance(deviceId: string): Promise<number | null> {
    return this.coins.getCoins(deviceId);
  }

  addBalance(deviceId: string, delta: number, initial: number): Promise<number> {
    return this.coins.addCoins(deviceId, delta, initial);
  }

  async appendLedger(entry: WalletLedgerEntry): Promise<void> {
    const list = this.ledger.get(entry.deviceId) ?? [];
    list.unshift({ ...entry });
    if (list.length > LEDGER_MAX) list.length = LEDGER_MAX;
    this.ledger.set(entry.deviceId, list);
  }

  async listLedger(deviceId: string, limit: number): Promise<WalletLedgerEntry[]> {
    return (this.ledger.get(deviceId) ?? []).slice(0, limit).map((e) => ({ ...e }));
  }

  async getUnlock(deviceId: string, feature: PremiumFeature): Promise<number | null> {
    return this.unlocks.get(deviceId)?.[feature] ?? null;
  }

  async setUnlock(deviceId: string, feature: PremiumFeature, expiresAt: number): Promise<void> {
    this.unlocks.set(deviceId, { ...this.unlocks.get(deviceId), [feature]: expiresAt });
  }

  async extendUnlock(deviceId: string, feature: PremiumFeature, ms: number, now: number): Promise<number> {
    const expiresAt = Math.max(now, this.unlocks.get(deviceId)?.[feature] ?? 0) + ms;
    this.unlocks.set(deviceId, { ...this.unlocks.get(deviceId), [feature]: expiresAt });
    return expiresAt;
  }

  async listUnlocks(deviceId: string): Promise<Record<string, number>> {
    return { ...this.unlocks.get(deviceId) };
  }

  async claimOnce(key: string): Promise<boolean> {
    if (this.claims.has(key)) return false;
    this.claims.add(key);
    return true;
  }

  async releaseClaim(key: string): Promise<void> {
    this.claims.delete(key);
  }

  async putOrder(order: BillingOrderRecord): Promise<void> {
    this.orders.set(order.orderId, { ...order });
    if (this.orders.size > ORDERS_MAX) {
      const oldest = this.orders.keys().next().value;
      if (oldest !== undefined) this.orders.delete(oldest);
    }
  }

  async getOrder(orderId: string): Promise<BillingOrderRecord | null> {
    const order = this.orders.get(orderId);
    return order ? { ...order } : null;
  }

  async listOrders(limit: number): Promise<BillingOrderRecord[]> {
    return [...this.orders.values()]
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
    await this.redis.multi().lpush(key, JSON.stringify(entry)).ltrim(key, 0, LEDGER_MAX - 1).exec();
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
    await this.redis.hset(`${this.prefix}unlock:${deviceId}`, feature, String(expiresAt));
  }

  async extendUnlock(deviceId: string, feature: PremiumFeature, ms: number, now: number): Promise<number> {
    const result = await this.redis.eval(
      EXTEND_UNLOCK_LUA,
      1,
      `${this.prefix}unlock:${deviceId}`,
      feature,
      String(ms),
      String(now),
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
    const res = await this.redis.set(`${this.prefix}once:${key}`, "1", "NX");
    return res === "OK";
  }

  async releaseClaim(key: string): Promise<void> {
    await this.redis.del(`${this.prefix}once:${key}`);
  }

  async putOrder(order: BillingOrderRecord): Promise<void> {
    const index = `${this.prefix}orders`;
    await this.redis
      .multi()
      .set(`${this.prefix}order:${order.orderId}`, JSON.stringify(order))
      .zadd(index, order.createdAt, order.orderId)
      .zremrangebyrank(index, 0, -ORDERS_MAX - 1)
      .exec();
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
