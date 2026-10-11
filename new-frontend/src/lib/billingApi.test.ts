import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { createBillingApi } from "@/lib/billingApi";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const PACKS = { enabled: true, premiumFiltersEnabled: true, keyId: "rzp_test_x", costPerDay: 100, packs: [{ id: "week", coins: 700, inr: 99 }], unlockDays: [1, 7, 30] };

describe("billingApi", () => {
  it("loads the public catalogue without a token", async () => {
    const fetch = vi.fn(async () => json(PACKS));
    const api = createBillingApi(fetch, "https://api.example/");
    expect(await api.getPacks()).toEqual(PACKS);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/api/billing/packs");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });

  it("rejects a catalogue of the wrong shape", async () => {
    const api = createBillingApi(async () => json({ nope: true }), "https://api.example");
    await expect(api.getPacks()).rejects.toBeInstanceOf(ApiError);
  });

  it("sends the session token as a bearer and posts JSON bodies", async () => {
    const fetch = vi.fn(async () => json({ ok: true, orderId: "order_1", amount: 9900, currency: "INR", keyId: "k", packId: "week", coins: 700 }));
    const api = createBillingApi(fetch, "https://api.example");
    const res = await api.createOrder("tok", "week");
    expect(res).toMatchObject({ ok: true, orderId: "order_1" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/api/billing/orders");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ packId: "week" }));
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("returns { ok: false } answers whatever the status, maps bare 429s and throws on garbage", async () => {
    const denied = createBillingApi(async () => json({ ok: false, error: "insufficient_coins" }, 402), "https://api.example");
    expect(await denied.unlock("tok", { feature: "gender_filter", days: 7 })).toEqual({ ok: false, error: "insufficient_coins" });
    const limited = createBillingApi(async () => new Response("", { status: 429 }), "https://api.example");
    expect(await limited.getWallet("tok")).toEqual({ ok: false, error: "rate_limited" });
    const broken = createBillingApi(async () => new Response("<html>", { status: 500 }), "https://api.example");
    await expect(broken.getWallet("tok")).rejects.toBeInstanceOf(ApiError);
    const offline = createBillingApi(async () => {
      throw new TypeError("Failed to fetch");
    }, "https://api.example");
    await expect(offline.verifyPayment("tok", { orderId: "o", paymentId: "p", signature: "s" })).rejects.toMatchObject({ status: null });
  });
});
