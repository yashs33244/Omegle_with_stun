import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createBilling, type BillingFeatureDeps } from "../../src/billing";
import { BillingService } from "../../src/billing/BillingService";
import {
  FakeRazorpay,
  RazorpayClient,
  checkoutSignature,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  webhookSignature,
} from "../../src/billing/razorpay";
import { MemoryWalletStore } from "../../src/billing/WalletStore";
import { loadConfig } from "../../src/config";
import { FlagsReader, MemoryFlagsStore } from "../../src/flags/flags";
import { createLogger } from "../../src/logger";
import { MemoryStore } from "../../src/store/MemoryStore";
import type { WalletView } from "../../src/protocol";

const DEVICE = "11111111-1111-4111-8111-111111111111";
const DAY = 24 * 60 * 60_000;

async function setup(opts: { gateway?: FakeRazorpay | null; webhookSecret?: string; now?: () => number } = {}) {
  const flags = new FlagsReader(new MemoryFlagsStore());
  await flags.refresh();
  const matchStore = new MemoryStore();
  const store = new MemoryWalletStore(matchStore);
  const pushed: WalletView[] = [];
  const billing = new BillingService({
    store,
    flags,
    logger: createLogger("silent"),
    initialCoins: 100,
    gateway: opts.gateway === undefined ? new FakeRazorpay() : opts.gateway,
    webhookSecret: opts.webhookSecret ?? "whsec",
    notify: (_device, view) => void pushed.push(view),
    now: opts.now,
  });
  return { billing, flags, store, matchStore, pushed };
}

describe("razorpay signatures", () => {
  // Vectors computed with node:crypto so the helper cannot drift from the documented formula.
  const secret = "test_key_secret_123";
  const expectedCheckout = createHmac("sha256", secret).update("order_A1|pay_B2").digest("hex");
  const body = Buffer.from('{"event":"payment.captured"}');
  const expectedWebhook = createHmac("sha256", "whsec").update(new Uint8Array(body)).digest("hex");

  test("checkout signature is HMAC-SHA256(key_secret, order_id|payment_id) in hex", () => {
    expect(checkoutSignature(secret, "order_A1", "pay_B2")).toBe(expectedCheckout);
    expect(verifyCheckoutSignature(secret, "order_A1", "pay_B2", expectedCheckout)).toBe(true);
    expect(verifyCheckoutSignature(secret, "order_A1", "pay_B2", expectedCheckout.toUpperCase())).toBe(true);
    expect(verifyCheckoutSignature(secret, "order_A1", "pay_B3", expectedCheckout)).toBe(false);
    expect(verifyCheckoutSignature("other", "order_A1", "pay_B2", expectedCheckout)).toBe(false);
  });

  test("webhook signature covers the raw body; wrong length, non-hex or missing signatures fail", () => {
    expect(webhookSignature("whsec", body)).toBe(expectedWebhook);
    expect(verifyWebhookSignature("whsec", body, expectedWebhook)).toBe(true);
    expect(verifyWebhookSignature("whsec", Buffer.from(body.toString() + " "), expectedWebhook)).toBe(false);
    expect(verifyWebhookSignature("whsec", body, expectedWebhook.slice(1))).toBe(false);
    expect(verifyWebhookSignature("whsec", body, "z".repeat(64))).toBe(false);
    expect(verifyWebhookSignature("whsec", body, undefined)).toBe(false);
  });

  test("RazorpayClient posts orders with basic auth and paise amounts", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new RazorpayClient("rzp_test_k", "sec", async (url, init) => {
      calls.push({ url, init: init! });
      return new Response(JSON.stringify({ id: "order_X", amount: 9900, currency: "INR", receipt: "r", notes: {}, status: "created" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const order = await client.createOrder({ amount: 9900, currency: "INR", receipt: "r", notes: { deviceId: DEVICE, packId: "week" } });
    expect(order.id).toBe("order_X");
    expect(calls[0]!.url).toBe("https://api.razorpay.com/v1/orders");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("rzp_test_k:sec").toString("base64")}`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ amount: 9900, currency: "INR", receipt: "r", notes: { deviceId: DEVICE, packId: "week" } });
    expect(client.verifyCheckout("order_X", "pay_Y", checkoutSignature("sec", "order_X", "pay_Y"))).toBe(true);
  });

  test("RazorpayClient turns network and HTTP failures into RazorpayError", async () => {
    const down = new RazorpayClient("k", "s", async () => {
      throw new Error("ECONNRESET");
    });
    await expect(down.createOrder({ amount: 1, currency: "INR", receipt: "r", notes: {} })).rejects.toThrow(/unreachable/);
    const denied = new RazorpayClient("k", "s", async () => new Response("{}", { status: 401 }));
    await expect(denied.createOrder({ amount: 1, currency: "INR", receipt: "r", notes: {} })).rejects.toThrow(/401/);
    const missing = new RazorpayClient("k", "s", async () => new Response("{}", { status: 404 }));
    expect(await missing.fetchPayment("pay_nope")).toBeNull();
  });

  test("RazorpayClient fetches payments by id", async () => {
    const calls: string[] = [];
    const client = new RazorpayClient("k", "s", async (input, init) => {
      calls.push(`${init?.method} ${input}`);
      return new Response(JSON.stringify({ id: "pay_1", order_id: "order_1", amount: 9900, currency: "INR", status: "captured" }));
    });
    expect(await client.fetchPayment("pay_1")).toMatchObject({ id: "pay_1", status: "captured" });
    expect(calls).toEqual(["GET https://api.razorpay.com/v1/payments/pay_1"]);
  });
});

describe("BillingService", () => {
  test("packs and cost come from the flags; a broken pack list falls back to the defaults", async () => {
    const { billing, flags } = await setup();
    expect(billing.catalogue()).toMatchObject({
      enabled: true,
      premiumFiltersEnabled: true,
      keyId: "rzp_test_fake",
      costPerDay: 100,
      packs: [
        { id: "week", coins: 700, inr: 99 },
        { id: "month", coins: 3000, inr: 299 },
      ],
      unlockDays: [1, 7, 30],
    });
    await flags.set({ coin_packs: '[{"id":"mini","coins":50,"inr":10}]', gender_filter_coins_per_day: 25 });
    expect(billing.packs()).toEqual([{ id: "mini", coins: 50, inr: 10 }]);
    expect(billing.costPerDay()).toBe(25);
    await expect(flags.set({ coin_packs: "not json" })).rejects.toThrow();
  });

  test("balance starts at initialCoins; earning adds a ledger entry", async () => {
    const { billing } = await setup();
    expect(await billing.balance(DEVICE)).toBe(100);
    expect(await billing.earn(DEVICE, 5, "room-1")).toBe(105);
    expect(await billing.ledger(DEVICE)).toMatchObject([{ delta: 5, reason: "earned", ref: "room-1" }]);
  });

  test("a payment is credited exactly once across verify and webhook", async () => {
    const { billing, pushed } = await setup();
    const order = await billing.createOrder(DEVICE, "week");
    if (!order.ok) throw new Error(order.error);
    expect(order).toMatchObject({ amount: 9900, currency: "INR", keyId: "rzp_test_fake", coins: 700 });
    expect(order.orderId).toMatch(/^order_fake_/);

    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_1", "nope")).toEqual({ ok: false, error: "bad_signature" });
    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_1", "fake-signature")).toEqual({ ok: true, coins: 800 });
    // Replayed success handler: nothing more is credited.
    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_1", "fake-signature")).toEqual({ ok: true, coins: 800 });

    const body = Buffer.from(
      JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_1", order_id: order.orderId, amount: 9900, currency: "INR", notes: { deviceId: DEVICE, packId: "week" } } } },
      }),
    );
    expect(await billing.handleWebhook(body, webhookSignature("whsec", body))).toBe("ignored");
    expect(await billing.handleWebhook(body, "00")).toBe("bad_signature");
    expect(await billing.balance(DEVICE)).toBe(800);
    expect(await billing.ledger(DEVICE)).toMatchObject([{ delta: 700, reason: "purchase", ref: "pay_1" }]);
    expect(await billing.listOrders()).toMatchObject([{ orderId: order.orderId, status: "paid", paymentId: "pay_1", packId: "week" }]);
    expect(pushed).toHaveLength(1);
  });

  test("the webhook refuses an amount that does not match the order, and another device's order", async () => {
    const { billing } = await setup();
    const order = await billing.createOrder(DEVICE, "week");
    if (!order.ok) throw new Error(order.error);
    const body = Buffer.from(
      JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_2", order_id: order.orderId, amount: 100, currency: "INR" } } },
      }),
    );
    expect(await billing.handleWebhook(body, webhookSignature("whsec", body))).toBe("payment_mismatch");
    expect(await billing.balance(DEVICE)).toBe(100);
    const other = "22222222-2222-4222-8222-222222222222";
    expect(await billing.verifyCheckout(other, order.orderId, "pay_3", "fake-signature")).toEqual({ ok: false, error: "payment_mismatch" });
    const ignored = Buffer.from(JSON.stringify({ event: "order.paid", payload: {} }));
    expect(await billing.handleWebhook(ignored, webhookSignature("whsec", ignored))).toBe("ignored");
  });

  test("a webhook for an order this instance never stored is refused, never rebuilt", async () => {
    const { billing } = await setup();
    const body = Buffer.from(
      JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_lost", order_id: "order_lost", amount: 29900, currency: "INR", notes: { device: "abc", packId: "month" } } } },
      }),
    );
    expect(await billing.handleWebhook(body, webhookSignature("whsec", body))).toBe("order_unknown");
    expect(await billing.balance(DEVICE)).toBe(100);
    expect(await billing.verifyCheckout(DEVICE, "order_lost", "pay_lost", "fake-signature")).toEqual({ ok: false, error: "order_unknown" });
  });

  test("verify credits once: a replay, even 31 days later, only returns the balance", async () => {
    let now = 1_700_000_000_000;
    const { billing, pushed } = await setup({ now: () => now });
    const order = await billing.createOrder(DEVICE, "week");
    if (!order.ok) throw new Error(order.error);
    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_once", "fake-signature")).toEqual({ ok: true, coins: 800 });
    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_once", "fake-signature")).toEqual({ ok: true, coins: 800 });
    now += 31 * DAY;
    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_once", "fake-signature")).toEqual({ ok: true, coins: 800 });
    // A different payment id against the same (paid) order is not credited either.
    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_other", "fake-signature")).toEqual({ ok: true, coins: 800 });
    expect(await billing.balance(DEVICE)).toBe(800);
    expect(await billing.ledger(DEVICE)).toHaveLength(1);
    expect(pushed).toHaveLength(1);
  });

  test("verify needs a captured payment: authorized answers payment_pending until the webhook credits", async () => {
    const gateway = new FakeRazorpay();
    const { billing } = await setup({ gateway });
    const order = await billing.createOrder(DEVICE, "week");
    if (!order.ok) throw new Error(order.error);
    gateway.capture(order.orderId, "pay_slow", "authorized");
    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_slow", "fake-signature")).toEqual({ ok: false, error: "payment_pending" });
    expect(await billing.balance(DEVICE)).toBe(100);
    // Razorpay's lookup can also disagree with the signature: wrong order, wrong amount, failed.
    const other = await billing.createOrder(DEVICE, "month");
    if (!other.ok) throw new Error(other.error);
    gateway.capture(other.orderId, "pay_elsewhere");
    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_elsewhere", "fake-signature")).toEqual({ ok: false, error: "payment_mismatch" });
    gateway.capture(order.orderId, "pay_failed", "failed");
    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_failed", "fake-signature")).toEqual({ ok: false, error: "payment_mismatch" });

    const body = Buffer.from(
      JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_slow", order_id: order.orderId, amount: 9900, currency: "INR" } } },
      }),
    );
    expect(await billing.handleWebhook(body, webhookSignature("whsec", body))).toBe("credited");
    expect(await billing.balance(DEVICE)).toBe(800);
    // The client's retry after capture is a replay now.
    gateway.capture(order.orderId, "pay_slow");
    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_slow", "fake-signature")).toEqual({ ok: true, coins: 800 });
    expect(await billing.handleWebhook(body, webhookSignature("whsec", body))).toBe("ignored");
    expect(await billing.balance(DEVICE)).toBe(800);
  });

  test("a credit that fails after the claim gives the claim back, so the retry credits exactly once", async () => {
    const { billing, store } = await setup();
    const order = await billing.createOrder(DEVICE, "week");
    if (!order.ok) throw new Error(order.error);
    const addBalance = store.addBalance.bind(store);
    let failures = 1;
    store.addBalance = async (deviceId, delta, initial) => {
      if (failures-- > 0) throw new Error("redis gone");
      return addBalance(deviceId, delta, initial);
    };
    await expect(billing.verifyCheckout(DEVICE, order.orderId, "pay_retry", "fake-signature")).rejects.toThrow("redis gone");
    expect(await billing.balance(DEVICE)).toBe(100);
    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_retry", "fake-signature")).toEqual({ ok: true, coins: 800 });
    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_retry", "fake-signature")).toEqual({ ok: true, coins: 800 });
    expect(await billing.ledger(DEVICE)).toHaveLength(1);
  });

  test("the gateway lookup failing answers upstream without crediting", async () => {
    const gateway = new FakeRazorpay();
    gateway.fetchPayment = async () => {
      throw new Error("timeout");
    };
    const { billing } = await setup({ gateway });
    const order = await billing.createOrder(DEVICE, "week");
    if (!order.ok) throw new Error(order.error);
    expect(await billing.verifyCheckout(DEVICE, order.orderId, "pay_x", "fake-signature")).toEqual({ ok: false, error: "upstream" });
    expect(await billing.balance(DEVICE)).toBe(100);
  });

  test("unlock debits cost per day x days, extends an active unlock and expires", async () => {
    let now = 1_700_000_000_000;
    const { billing, pushed } = await setup({ now: () => now });
    expect(await billing.entitled(DEVICE, "gender_filter")).toBe(false);
    expect(await billing.unlock(DEVICE, "gender_filter", 7)).toEqual({ ok: false, error: "insufficient_coins" });
    expect(await billing.balance(DEVICE)).toBe(100); // the failed debit was undone
    expect(await billing.unlock(DEVICE, "gender_filter", 1)).toEqual({ ok: true, coins: 0, expiresAt: now + DAY });
    expect(await billing.entitled(DEVICE, "gender_filter")).toBe(true);
    expect(await billing.walletView(DEVICE)).toEqual({ coins: 0, unlocks: [{ feature: "gender_filter", expiresAt: now + DAY }] });
    expect(pushed.at(-1)).toEqual({ coins: 0, unlocks: [{ feature: "gender_filter", expiresAt: now + DAY }] });

    await billing.adjust(DEVICE, 700, "support");
    now += DAY / 2;
    expect(await billing.unlock(DEVICE, "gender_filter", 7)).toEqual({ ok: true, coins: 0, expiresAt: now + DAY / 2 + 7 * DAY });
    now += 8 * DAY;
    expect(await billing.entitled(DEVICE, "gender_filter")).toBe(false);
    expect((await billing.walletView(DEVICE)).unlocks).toEqual([]);
    expect(await billing.ledger(DEVICE)).toMatchObject([
      { delta: -700, reason: "unlock", ref: "gender_filter:7d" },
      { delta: 700, reason: "admin", ref: "support" },
      { delta: -100, reason: "unlock", ref: "gender_filter:1d" },
    ]);
  });

  test("premium_filters_enabled=false makes the gender filter free", async () => {
    const { billing, flags } = await setup();
    expect(await billing.mayUseGenderFilter(DEVICE)).toBe(false);
    await flags.set({ premium_filters_enabled: false });
    expect(await billing.mayUseGenderFilter(DEVICE)).toBe(true);
    expect(billing.catalogue().premiumFiltersEnabled).toBe(false);
  });

  test("without Razorpay keys orders and verification are disabled but coins still work", async () => {
    const { billing } = await setup({ gateway: null });
    expect(billing.enabled).toBe(false);
    expect(billing.webhookEnabled).toBe(false);
    expect(billing.catalogue()).toMatchObject({ enabled: false, keyId: null });
    expect(await billing.createOrder(DEVICE, "week")).toEqual({ ok: false, error: "billing_disabled" });
    expect(await billing.verifyCheckout(DEVICE, "o", "p", "s")).toEqual({ ok: false, error: "billing_disabled" });
    expect(await billing.createOrder(DEVICE, "week")).toEqual({ ok: false, error: "billing_disabled" });
    expect(await billing.unlock(DEVICE, "gender_filter", 1)).toMatchObject({ ok: true, coins: 0 });
  });

  test("an unknown pack is refused", async () => {
    const { billing } = await setup();
    expect(await billing.createOrder(DEVICE, "gold")).toEqual({ ok: false, error: "unknown_pack" });
  });
});

describe("createBilling", () => {
  const prod = {
    NODE_ENV: "production",
    CORS_ORIGINS: "https://a.com",
    SESSION_SECRET: "s".repeat(32),
    TURNSTILE_DISABLED: "true",
    ADMIN_TOKEN: "a".repeat(24),
    RAZORPAY_KEY_ID: "rzp_live_x",
    RAZORPAY_KEY_SECRET: "secret",
    RAZORPAY_WEBHOOK_SECRET: "whsec",
  };

  async function build(env: Record<string, string>, extra: Partial<BillingFeatureDeps> = {}) {
    const flags = new FlagsReader(new MemoryFlagsStore());
    await flags.refresh();
    const errors: string[] = [];
    const logger = createLogger("silent");
    logger.error = ((msg: unknown) => void errors.push(String(msg))) as typeof logger.error;
    const billing = createBilling({ config: loadConfig(env), flags, store: new MemoryStore(), logger, ...extra });
    return { billing, errors };
  }

  test("production with Razorpay keys but no durable store disables real payments", async () => {
    const { billing, errors } = await build(prod);
    expect(billing.enabled).toBe(false);
    expect(billing.catalogue()).toMatchObject({ enabled: false, keyId: null });
    expect(errors).toEqual(["BILLING DISABLED: real payments need a durable store (REDIS_URL)"]);
  });

  test("a durable wallet store (or development) keeps the real gateway", async () => {
    const matchStore = new MemoryStore();
    const durable = await build(prod, { walletStore: new MemoryWalletStore(matchStore) });
    expect(durable.billing.enabled).toBe(true);
    expect(durable.billing.catalogue().keyId).toBe("rzp_live_x");
    expect(durable.errors).toEqual([]);
    const dev = await build({ RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "secret" });
    expect(dev.billing.enabled).toBe(true);
  });
});
