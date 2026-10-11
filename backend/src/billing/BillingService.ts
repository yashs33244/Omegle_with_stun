/**
 * Coins and premium unlocks.
 *
 * One balance per device (earned in calls, bought as coin packs, adjusted by
 * admins) and timed unlocks bought with it. Every movement writes a ledger
 * entry. Purchases are credited exactly once per Razorpay payment id whether
 * the credit comes from the Checkout success handler (POST /verify) or the
 * payment.captured webhook, whichever arrives first.
 *
 * Flags (operator-editable, no deploy):
 *   premium_filters_enabled     false makes the gender filter free
 *   gender_filter_coins_per_day price of one day of gender_filter
 *   coin_packs                  JSON array of {id, coins, inr}
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FlagsReader } from "../flags/flags";
import type { Logger } from "../logger";
import {
  FLAG_DEFAULTS,
  UNLOCK_DAYS,
  coinPacksSchema,
  type BillingError,
  type BillingOrder,
  type BillingOrderRecord,
  type BillingPacksResponse,
  type BillingResponse,
  type CoinPack,
  type PremiumFeature,
  type UnlockDays,
  type WalletLedgerEntry,
  type WalletView,
} from "../protocol";
import { verifyWebhookSignature, type RazorpayGateway } from "./razorpay";
import { CLAIM_TTL_MS, type WalletStore } from "./WalletStore";

const DAY_MS = 24 * 60 * 60_000;

export interface BillingDeps {
  store: WalletStore;
  flags: FlagsReader;
  logger: Logger;
  /** Balance a device starts with (Config.initialCoins). */
  initialCoins: number;
  /** Null when no Razorpay keys are configured: orders and verification answer billing_disabled. */
  gateway: RazorpayGateway | null;
  /** Unset: the webhook route answers billing_disabled. */
  webhookSecret?: string;
  /** Pushes wallet:update to the device's live socket, if any. */
  notify?: (deviceId: string, view: WalletView) => void | Promise<void>;
  now?: () => number;
}

/** payment.captured as Razorpay posts it (only the fields used). */
const webhookEventSchema = z.object({
  event: z.string(),
  payload: z
    .object({
      payment: z
        .object({
          entity: z.object({
            id: z.string().min(1),
            order_id: z.string().min(1).nullable().optional(),
            amount: z.number().int(),
            currency: z.string(),
            notes: z.union([z.record(z.string()), z.array(z.unknown())]).optional(),
          }),
        })
        .optional(),
    })
    .optional(),
});

export type WebhookOutcome = "credited" | "ignored" | "bad_signature" | "invalid" | "order_not_found" | "payment_mismatch";

interface PaymentFacts {
  paymentId: string;
  orderId: string;
  amount: number;
  currency: string;
}

export class BillingService {
  private readonly store: WalletStore;
  private readonly flags: FlagsReader;
  private readonly log: Logger;
  private readonly initialCoins: number;
  private readonly gateway: RazorpayGateway | null;
  private readonly webhookSecret?: string;
  private readonly notify?: BillingDeps["notify"];
  private readonly now: () => number;

  constructor(deps: BillingDeps) {
    this.store = deps.store;
    this.flags = deps.flags;
    this.log = deps.logger;
    this.initialCoins = deps.initialCoins;
    this.gateway = deps.gateway;
    this.webhookSecret = deps.webhookSecret;
    this.notify = deps.notify;
    this.now = deps.now ?? Date.now;
  }

  /* ---------------------------------------------------------------- */
  /* Catalogue                                                         */
  /* ---------------------------------------------------------------- */

  get enabled(): boolean {
    return this.gateway !== null;
  }

  get webhookEnabled(): boolean {
    return this.gateway !== null && Boolean(this.webhookSecret);
  }

  costPerDay(): number {
    return this.flags.current().gender_filter_coins_per_day;
  }

  packs(): CoinPack[] {
    const raw = this.flags.current().coin_packs;
    try {
      const parsed = coinPacksSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to the defaults
    }
    this.log.warn({ raw }, "coin_packs flag is not a valid pack list; using defaults");
    return coinPacksSchema.parse(JSON.parse(FLAG_DEFAULTS.coin_packs));
  }

  catalogue(): BillingPacksResponse {
    return {
      enabled: this.enabled,
      premiumFiltersEnabled: this.flags.current().premium_filters_enabled,
      keyId: this.gateway?.keyId ?? null,
      costPerDay: this.costPerDay(),
      packs: this.packs(),
      unlockDays: UNLOCK_DAYS,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Balance and entitlements                                          */
  /* ---------------------------------------------------------------- */

  async balance(deviceId: string): Promise<number> {
    return (await this.store.getBalance(deviceId)) ?? this.initialCoins;
  }

  async walletView(deviceId: string): Promise<WalletView> {
    const [coins, unlocks] = await Promise.all([this.balance(deviceId), this.store.listUnlocks(deviceId)]);
    const now = this.now();
    return {
      coins,
      unlocks: Object.entries(unlocks)
        .filter(([, expiresAt]) => expiresAt > now)
        .map(([feature, expiresAt]) => ({ feature: feature as PremiumFeature, expiresAt })),
    };
  }

  async ledger(deviceId: string, limit = 50): Promise<WalletLedgerEntry[]> {
    return this.store.listLedger(deviceId, limit);
  }

  async entitled(deviceId: string, feature: PremiumFeature): Promise<boolean> {
    const expiresAt = await this.store.getUnlock(deviceId, feature);
    return expiresAt !== null && expiresAt > this.now();
  }

  /** The gender filter is free while premium_filters_enabled is off. */
  async mayUseGenderFilter(deviceId: string): Promise<boolean> {
    if (!this.flags.current().premium_filters_enabled) return true;
    return this.entitled(deviceId, "gender_filter");
  }

  /** Coins earned in a call (MatchService rewards). Returns the new balance. */
  async earn(deviceId: string, delta: number, roomId: string): Promise<number> {
    const balance = await this.store.addBalance(deviceId, delta, this.initialCoins);
    await this.record(deviceId, delta, "earned", roomId);
    return balance;
  }

  /** Admin credit or debit; may take the balance below zero on purpose. */
  async adjust(deviceId: string, delta: number, note: string): Promise<WalletView> {
    await this.store.addBalance(deviceId, delta, this.initialCoins);
    await this.record(deviceId, delta, "admin", note);
    return this.push(deviceId);
  }

  async unlock(
    deviceId: string,
    feature: PremiumFeature,
    days: UnlockDays,
  ): Promise<BillingResponse<{ coins: number; expiresAt: number }>> {
    const cost = this.costPerDay() * days;
    const balance = await this.debit(deviceId, cost);
    if (balance === null) return { ok: false, error: "insufficient_coins" };
    const now = this.now();
    const current = (await this.store.getUnlock(deviceId, feature)) ?? 0;
    const expiresAt = Math.max(now, current) + days * DAY_MS;
    await this.store.setUnlock(deviceId, feature, expiresAt);
    await this.record(deviceId, -cost, "unlock", `${feature}:${days}d`);
    await this.push(deviceId);
    return { ok: true, coins: balance, expiresAt };
  }

  /* ---------------------------------------------------------------- */
  /* Purchases                                                         */
  /* ---------------------------------------------------------------- */

  async createOrder(deviceId: string, packId: string): Promise<BillingResponse<BillingOrder>> {
    if (!this.gateway) return { ok: false, error: "billing_disabled" };
    const pack = this.packs().find((p) => p.id === packId);
    if (!pack) return { ok: false, error: "unknown_pack" };
    const amount = pack.inr * 100;
    // Razorpay caps receipts at 40 chars; a hash keeps the raw device id out of their dashboard.
    const receipt = `${createHash("sha256").update(deviceId).digest("hex").slice(0, 24)}-${randomBytes(6).toString("hex")}`;
    let created;
    try {
      created = await this.gateway.createOrder({ amount, currency: "INR", receipt, notes: { deviceId, packId } });
    } catch (err) {
      this.log.error({ err }, "razorpay order creation failed");
      return { ok: false, error: "upstream" };
    }
    const record: BillingOrderRecord = {
      orderId: created.id,
      deviceId,
      packId,
      coins: pack.coins,
      amount,
      currency: "INR",
      status: "created",
      paymentId: null,
      createdAt: this.now(),
      paidAt: null,
    };
    await this.store.putOrder(record);
    return { ok: true, orderId: created.id, amount, currency: "INR", keyId: this.gateway.keyId, packId, coins: pack.coins };
  }

  /**
   * Checkout success handler: verifies razorpay_signature and credits the
   * pack. Safe to call again for the same payment (the second call just
   * returns the balance).
   */
  async verifyCheckout(
    deviceId: string,
    orderId: string,
    paymentId: string,
    signature: string,
  ): Promise<BillingResponse<{ coins: number }>> {
    if (!this.gateway) return { ok: false, error: "billing_disabled" };
    if (!this.gateway.verifyCheckout(orderId, paymentId, signature)) return { ok: false, error: "bad_signature" };
    const order = await this.resolveOrder(orderId);
    if (!order) return { ok: false, error: "order_not_found" };
    if (order.deviceId !== deviceId) return { ok: false, error: "payment_mismatch" };
    // Checkout does not return the amount; the signature binds the payment to this order.
    const result = await this.credit(order, { paymentId, orderId, amount: order.amount, currency: order.currency });
    if (!result.ok) return result;
    return { ok: true, coins: result.coins };
  }

  /** payment.captured webhook. Other events are acknowledged and ignored. */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<WebhookOutcome> {
    if (!this.webhookSecret) return "bad_signature";
    if (!verifyWebhookSignature(this.webhookSecret, rawBody, signature)) return "bad_signature";
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return "invalid";
    }
    const parsed = webhookEventSchema.safeParse(json);
    if (!parsed.success) return "invalid";
    const { event, payload } = parsed.data;
    if (event !== "payment.captured") return "ignored";
    const payment = payload?.payment?.entity;
    if (!payment?.order_id) return "invalid";
    const order = await this.resolveOrder(payment.order_id, Array.isArray(payment.notes) ? undefined : payment.notes);
    if (!order) return "order_not_found";
    const result = await this.credit(order, {
      paymentId: payment.id,
      orderId: payment.order_id,
      amount: payment.amount,
      currency: payment.currency,
    });
    if (!result.ok) return result.error === "payment_mismatch" ? "payment_mismatch" : "invalid";
    return result.fresh ? "credited" : "ignored";
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * The stored order, or one rebuilt from Razorpay's copy when this
   * instance lost it (memory store restart). Notes carry deviceId and packId.
   */
  private async resolveOrder(orderId: string, notes?: Record<string, string>): Promise<BillingOrderRecord | null> {
    const stored = await this.store.getOrder(orderId);
    if (stored) return stored;
    let facts: { amount: number; currency: string; notes: Record<string, string> } | null = null;
    if (notes?.deviceId && notes.packId) {
      const pack = this.packs().find((p) => p.id === notes.packId);
      if (pack) facts = { amount: pack.inr * 100, currency: "INR", notes };
    }
    if (!facts && this.gateway) {
      try {
        const remote = await this.gateway.fetchOrder(orderId);
        if (remote) facts = { amount: remote.amount, currency: remote.currency, notes: remote.notes ?? {} };
      } catch (err) {
        this.log.warn({ err, orderId }, "could not fetch a lost order from razorpay");
      }
    }
    if (!facts) return null;
    const pack = this.packs().find((p) => p.id === facts.notes.packId);
    const deviceId = facts.notes.deviceId;
    if (!pack || !deviceId || facts.currency !== "INR" || facts.amount !== pack.inr * 100) return null;
    this.log.warn({ orderId }, "rebuilt a lost order from razorpay notes");
    const record: BillingOrderRecord = {
      orderId,
      deviceId,
      packId: pack.id,
      coins: pack.coins,
      amount: facts.amount,
      currency: "INR",
      status: "created",
      paymentId: null,
      createdAt: this.now(),
      paidAt: null,
    };
    await this.store.putOrder(record);
    return record;
  }

  /** Credits the order's pack once per payment id. `fresh` is false for a replay. */
  private async credit(
    order: BillingOrderRecord,
    payment: PaymentFacts,
  ): Promise<BillingResponse<{ coins: number; fresh: boolean }>> {
    if (payment.amount !== order.amount || payment.currency !== order.currency) {
      this.log.warn({ orderId: order.orderId, paymentId: payment.paymentId }, "payment does not match its order");
      return { ok: false, error: "payment_mismatch" };
    }
    const fresh = await this.store.claimOnce(`payment:${payment.paymentId}`, CLAIM_TTL_MS);
    if (!fresh) return { ok: true, coins: await this.balance(order.deviceId), fresh: false };
    const coins = await this.store.addBalance(order.deviceId, order.coins, this.initialCoins);
    await this.record(order.deviceId, order.coins, "purchase", payment.paymentId);
    await this.store.putOrder({ ...order, status: "paid", paymentId: payment.paymentId, paidAt: this.now() });
    this.log.info({ orderId: order.orderId, packId: order.packId, coins: order.coins }, "coins credited");
    await this.push(order.deviceId);
    return { ok: true, coins, fresh: true };
  }

  /** Takes `cost` coins; null (nothing taken) when the balance is too low. */
  private async debit(deviceId: string, cost: number): Promise<number | null> {
    const balance = await this.store.addBalance(deviceId, -cost, this.initialCoins);
    if (balance >= 0) return balance;
    await this.store.addBalance(deviceId, cost, this.initialCoins);
    return null;
  }

  private record(deviceId: string, delta: number, reason: WalletLedgerEntry["reason"], ref: string | null): Promise<void> {
    return this.store.appendLedger({ id: randomUUID(), deviceId, delta, reason, ref, at: this.now() });
  }

  private async push(deviceId: string): Promise<WalletView> {
    const view = await this.walletView(deviceId);
    try {
      await this.notify?.(deviceId, view);
    } catch (err) {
      this.log.warn({ err }, "wallet push failed");
    }
    return view;
  }

  /** Orders this server created, newest first (admin). */
  listOrders(limit = 100): Promise<BillingOrderRecord[]> {
    return this.store.listOrders(limit);
  }
}

/** HTTP status per BillingError, used by http/billing.ts. */
export const BILLING_STATUS: Record<BillingError, number> = {
  billing_disabled: 503,
  session_required: 401,
  invalid: 400,
  rate_limited: 429,
  unknown_pack: 404,
  order_not_found: 404,
  bad_signature: 403,
  payment_mismatch: 409,
  insufficient_coins: 402,
  upstream: 502,
};
