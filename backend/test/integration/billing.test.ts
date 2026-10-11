/**
 * Billing end to end: the session gate on, the fake Razorpay gateway
 * (RAZORPAY_FAKE) and the real REST, socket and admin surfaces.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { FAKE_SIGNATURE } from "../../src/billing";
import { webhookSignature } from "../../src/billing/razorpay";
import { MemoryWalletStore } from "../../src/billing/WalletStore";
import type { Config } from "../../src/config";
import type { BillingOrder, BillingResponse, WalletView } from "../../src/protocol";
import { MemoryStore } from "../../src/store/MemoryStore";
import { connectWithSession, hello, next, prefs, profile, record, sendHello, startServer, type TestServer } from "../helpers";

const ADMIN = "x".repeat(24);
const WEBHOOK_SECRET = "whsec_test";

let ts: TestServer;
afterEach(() => ts?.close());

function boot(overrides: Partial<Config> = {}) {
  return startServer({
    requireSession: true,
    razorpayFake: true,
    razorpayWebhookSecret: WEBHOOK_SECRET,
    adminToken: ADMIN,
    ...overrides,
  });
}

async function api<T>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<{ status: number; body: T }> {
  const { token, headers, ...rest } = init;
  const res = await fetch(`${ts.url}/api/billing${path}`, {
    ...rest,
    headers: {
      ...(rest.body && !(rest.body instanceof Buffer) ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  return { status: res.status, body: (await res.json()) as T };
}

function post(path: string, token: string | null, body: unknown) {
  return api<Record<string, unknown>>(path, { method: "POST", token, body: JSON.stringify(body) });
}

async function admin(path: string, init: RequestInit = {}) {
  const res = await fetch(`${ts.url}/admin/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", ...init.headers },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Buys the week pack through the fake gateway. */
async function buyWeek(token: string): Promise<BillingOrder> {
  const order = await api<BillingResponse<BillingOrder>>("/orders", { method: "POST", token, body: JSON.stringify({ packId: "week" }) });
  expect(order.status).toBe(200);
  if (!order.body.ok) throw new Error(order.body.error);
  const paymentId = `pay_${Math.random().toString(16).slice(2)}`;
  const verify = await post("/verify", token, { orderId: order.body.orderId, paymentId, signature: FAKE_SIGNATURE });
  expect(verify.status).toBe(200);
  expect(verify.body).toMatchObject({ ok: true, coins: 800 });
  return order.body;
}

describe("premium gender filter", () => {
  test("hello downgrades a locked gender filter; session:preferences refuses it; admin credit + unlock makes them pass", async () => {
    ts = await boot();
    const { client, deviceId, sessionToken } = await connectWithSession(ts);
    const female = hello({ deviceId, profile: profile({ gender: "male" }), preferences: prefs({ genderFilter: "female" }) });
    const wallet = next(client, "wallet:update");
    expect(await sendHello(client, female)).toMatchObject({ ok: true, coins: 100, genderFilter: "all" });
    expect(await wallet).toEqual({ coins: 100, unlocks: [] });
    const refused = await client.timeout(1000).emitWithAck("session:preferences", { preferences: prefs({ genderFilter: "female" }) });
    expect(refused).toMatchObject({ ok: false, error: "premium_required" });

    // Support credits 600 coins; the device unlocks a week (700) and the filter saves.
    const credit = await admin(`/wallets/${deviceId}/adjust`, { method: "POST", body: JSON.stringify({ delta: 600, note: "goodwill" }) });
    expect(credit.status).toBe(200);
    expect(credit.body).toMatchObject({ deviceId, coins: 700, unlocks: [], ledger: [{ delta: 600, reason: "admin", ref: "goodwill" }] });

    const audit = await admin("/audit");
    expect(audit.body).toMatchObject([{ action: "wallet.adjust", target: deviceId, note: "+600: goodwill" }]);

    const pushed = next(client, "wallet:update");
    const unlock = await post("/unlock", sessionToken, { feature: "gender_filter", days: 7 });
    expect(unlock.status).toBe(200);
    expect(unlock.body).toMatchObject({ ok: true, coins: 0 });
    expect((await pushed).unlocks).toMatchObject([{ feature: "gender_filter" }]);

    const saved = await client.timeout(1000).emitWithAck("session:preferences", { preferences: prefs({ genderFilter: "female" }) });
    expect(saved).toEqual({ ok: true });
    expect(await sendHello(client, female)).toMatchObject({ ok: true, coins: 0, genderFilter: "female" });

    const view = await admin(`/wallets/${deviceId}`);
    expect(view.body).toMatchObject({ coins: 0, unlocks: [{ feature: "gender_filter" }] });
    expect((view.body.ledger as unknown[]).length).toBe(2);
  });

  test("an unlock that lapses mid-session stops applying at the next queue entry", async () => {
    const walletStore = new MemoryWalletStore(new MemoryStore());
    ts = await startServer({ requireSession: true, razorpayFake: true, razorpayWebhookSecret: WEBHOOK_SECRET, adminToken: ADMIN }, undefined, {
      billing: { walletStore },
    });
    const a = await connectWithSession(ts);
    const b = await connectWithSession(ts);
    await walletStore.setUnlock(a.deviceId, "gender_filter", Date.now() + 60_000);
    const female = hello({ deviceId: a.deviceId, profile: profile({ gender: "male" }), preferences: prefs({ genderFilter: "female" }) });
    expect(await sendHello(a.client, female)).toMatchObject({ ok: true, genderFilter: "female" });
    const errors = record(a.client, "server:error");
    const found = next(a.client, "match:found", 3000);
    expect(await sendHello(b.client, hello({ deviceId: b.deviceId, profile: profile({ gender: "female" }) }))).toMatchObject({ ok: true });
    const { roomId } = await found;
    await next(b.client, "match:found");
    expect(errors).toEqual([]);

    // The unlock runs out while the two are in the match prompt.
    await walletStore.setUnlock(a.deviceId, "gender_filter", Date.now() - 1);
    const wallet = next(a.client, "wallet:update");
    const requeued = next(a.client, "queue:waiting");
    a.client.emit("match:decline", { roomId });
    await requeued;
    expect(await wallet).toEqual({ coins: 100, unlocks: [] });
    expect(errors).toEqual([{ code: "premium_required", message: expect.any(String) }]);
    const socketId = await ts.store.getDeviceSocket(a.deviceId);
    expect((await ts.store.getSession(socketId!))?.preferences.genderFilter).toBe("all");
  });
});

describe("billing REST", () => {
  test("packs are public; wallet, orders, verify and unlock need a session token", async () => {
    ts = await boot();
    const packs = await api<Record<string, unknown>>("/packs");
    expect(packs.status).toBe(200);
    expect(packs.body).toMatchObject({
      enabled: true,
      premiumFiltersEnabled: true,
      keyId: "rzp_test_fake",
      costPerDay: 100,
      packs: [{ id: "week", coins: 700, inr: 99 }, { id: "month", coins: 3000, inr: 299 }],
      unlockDays: [1, 7, 30],
    });
    for (const path of ["/wallet"]) {
      expect((await api(path)).status).toBe(401);
      expect((await api(path, { token: "c1.bogus.bogus" })).status).toBe(401);
    }
    for (const path of ["/orders", "/verify", "/unlock"]) expect((await post(path, null, {})).status).toBe(401);
    expect((await api("/nothing")).status).toBe(404);
  });

  test("buying a pack credits coins once, even when the webhook and the success handler both arrive", async () => {
    ts = await boot();
    const { client, deviceId, sessionToken } = await connectWithSession(ts);
    await sendHello(client, hello({ deviceId }));
    const pushed: WalletView[] = [];
    client.on("wallet:update", (p) => pushed.push(p));

    const order = await buyWeek(sessionToken);
    expect(order).toMatchObject({ amount: 9900, currency: "INR", keyId: "rzp_test_fake", packId: "week", coins: 700 });
    const wallet = await api<WalletView>("/wallet", { token: sessionToken });
    expect(wallet.body).toMatchObject({ coins: 800, unlocks: [] });

    const orders = await admin("/billing/orders");
    const paid = (orders.body as unknown as Array<Record<string, unknown>>)[0]!;
    expect(paid).toMatchObject({ orderId: order.orderId, deviceId, status: "paid" });

    const event = Buffer.from(
      JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: paid.paymentId, order_id: order.orderId, amount: 9900, currency: "INR", notes: { deviceId, packId: "week" } } } },
      }),
    );
    const replay = () =>
      fetch(`${ts.url}/api/billing/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-razorpay-signature": webhookSignature(WEBHOOK_SECRET, event) },
        body: event,
      });
    expect(await (await replay()).json()).toEqual({ ok: true, outcome: "ignored" });
    expect(await (await replay()).json()).toEqual({ ok: true, outcome: "ignored" });
    expect((await api<WalletView>("/wallet", { token: sessionToken })).body.coins).toBe(800);

    const forged = await fetch(`${ts.url}/api/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": "00" },
      body: event,
    });
    expect(forged.status).toBe(403);

    // A webhook that beats the success handler credits; the later /verify is a no-op.
    const second = await api<BillingResponse<BillingOrder>>("/orders", { method: "POST", token: sessionToken, body: JSON.stringify({ packId: "month" }) });
    if (!second.body.ok) throw new Error(second.body.error);
    const event2 = Buffer.from(
      JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_first", order_id: second.body.orderId, amount: 29900, currency: "INR", notes: {} } } },
      }),
    );
    const first = await fetch(`${ts.url}/api/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": webhookSignature(WEBHOOK_SECRET, event2) },
      body: event2,
    });
    expect(await first.json()).toEqual({ ok: true, outcome: "credited" });
    const verify = await post("/verify", sessionToken, { orderId: second.body.orderId, paymentId: "pay_first", signature: FAKE_SIGNATURE });
    expect(verify.body).toEqual({ ok: true, coins: 3800 });
    expect(pushed.map((p) => p.coins)).toEqual([100, 800, 3800]);
  });

  test("bad input and unknown packs are refused; unlock needs enough coins", async () => {
    ts = await boot();
    const { sessionToken } = await connectWithSession(ts);
    expect((await post("/orders", sessionToken, { packId: "gold" })).status).toBe(404);
    expect((await post("/orders", sessionToken, { packId: "BAD PACK" })).status).toBe(400);
    expect((await post("/verify", sessionToken, { orderId: "order_x", paymentId: "pay_x", signature: "zzz" })).status).toBe(403);
    expect((await post("/verify", sessionToken, { orderId: "order_x", paymentId: "pay_x", signature: FAKE_SIGNATURE })).status).toBe(404);
    expect((await post("/unlock", sessionToken, { feature: "gender_filter", days: 2 })).status).toBe(400);
    const poor = await post("/unlock", sessionToken, { feature: "gender_filter", days: 30 });
    expect(poor.status).toBe(402);
    expect(poor.body).toEqual({ ok: false, error: "insufficient_coins" });
    const day = await post("/unlock", sessionToken, { feature: "gender_filter", days: 1 });
    expect(day.body).toMatchObject({ ok: true, coins: 0 });
  });

  test("without Razorpay keys the shop answers billing_disabled and the webhook 503", async () => {
    ts = await boot({ razorpayFake: false, razorpayWebhookSecret: undefined });
    const { sessionToken } = await connectWithSession(ts);
    expect((await api("/packs")).body).toMatchObject({ enabled: false, keyId: null });
    expect((await post("/orders", sessionToken, { packId: "week" })).status).toBe(503);
    const hook = await fetch(`${ts.url}/api/billing/webhook`, { method: "POST", body: "{}" });
    expect(hook.status).toBe(503);
  });
});
