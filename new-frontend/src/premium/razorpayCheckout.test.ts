import { afterEach, describe, expect, it, vi } from "vitest";
import { openCheckout } from "./razorpayCheckout";
import type { BillingOrder } from "@/lib/protocol";

const order: BillingOrder = { orderId: "order_1", amount: 9900, currency: "INR", keyId: "rzp_test_key", packId: "p1", coins: 100 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete window.__chizzyFakeCheckout;
  delete window.Razorpay;
});

describe("openCheckout", () => {
  it("ignores window.__chizzyFakeCheckout outside e2e builds and uses Razorpay", async () => {
    vi.stubEnv("VITE_E2E", "");
    const fake = vi.fn(async () => ({ status: "paid" as const, paymentId: "pay_fake", signature: "fake" }));
    window.__chizzyFakeCheckout = fake;
    const open = vi.fn();
    const Razorpay = vi.fn(function (this: { open: () => void; on: () => void }, _options: { modal: { ondismiss: () => void } }) {
      this.open = open;
      this.on = vi.fn();
    });
    window.Razorpay = Razorpay as unknown as typeof window.Razorpay;

    const pending = openCheckout(order, { name: "Chizzy", description: "100 coins" });
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(fake).not.toHaveBeenCalled();
    expect(Razorpay).toHaveBeenCalledWith(expect.objectContaining({ key: "rzp_test_key", order_id: "order_1", amount: 9900 }));
    Razorpay.mock.calls[0]![0].modal.ondismiss();
    await expect(pending).resolves.toEqual({ status: "dismissed" });
  });

  it("uses the fake only in e2e builds", async () => {
    vi.stubEnv("VITE_E2E", "1");
    const fake = vi.fn(async () => ({ status: "paid" as const, paymentId: "pay_fake", signature: "fake" }));
    window.__chizzyFakeCheckout = fake;
    await expect(openCheckout(order, { name: "Chizzy", description: "100 coins" })).resolves.toEqual({
      status: "paid",
      paymentId: "pay_fake",
      signature: "fake",
    });
    expect(fake).toHaveBeenCalledWith(order);
  });
});
