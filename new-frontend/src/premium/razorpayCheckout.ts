/**
 * Razorpay Checkout in the browser: loads checkout.js lazily (only when
 * someone presses Buy), opens the hosted modal for an order and resolves
 * with the payment id and signature the server verifies at POST /verify.
 *
 * Test seam: when `window.__chizzyFakeCheckout` is set (e2e only), it is
 * called instead of Razorpay and must resolve with the same result shape.
 */
import type { BillingOrder } from "@/lib/protocol";

export const CHECKOUT_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";

export type CheckoutResult =
  | { status: "paid"; paymentId: string; signature: string }
  | { status: "dismissed" }
  | { status: "failed"; reason: string | null };

export type FakeCheckout = (order: BillingOrder) => Promise<CheckoutResult>;

interface RazorpaySuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayFailure {
  error?: { description?: string };
}

interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  order_id: string;
  name: string;
  description: string;
  handler: (res: RazorpaySuccess) => void;
  modal: { ondismiss: () => void };
  theme: { color: string };
  retry: { enabled: boolean };
}

interface RazorpayInstance {
  open(): void;
  on(event: "payment.failed", cb: (res: RazorpayFailure) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
    __chizzyFakeCheckout?: FakeCheckout;
  }
}

let loading: Promise<void> | null = null;

/** Resolves once window.Razorpay exists; rejects when the script cannot load (offline, blocked). */
export function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.Razorpay ? resolve() : reject(new Error("checkout.js loaded without Razorpay")));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("could not load checkout.js"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export async function openCheckout(order: BillingOrder, opts: { name: string; description: string }): Promise<CheckoutResult> {
  if (window.__chizzyFakeCheckout) return window.__chizzyFakeCheckout(order);
  await loadCheckout();
  const Razorpay = window.Razorpay;
  if (!Razorpay) throw new Error("Razorpay unavailable");
  return new Promise<CheckoutResult>((resolve) => {
    let settled = false;
    const settle = (result: CheckoutResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const instance = new Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      order_id: order.orderId,
      name: opts.name,
      description: opts.description,
      handler: (res) => settle({ status: "paid", paymentId: res.razorpay_payment_id, signature: res.razorpay_signature }),
      modal: { ondismiss: () => settle({ status: "dismissed" }) },
      theme: { color: "#facc15" },
      // One result per open: a failed attempt closes the modal and Buy can be pressed again.
      retry: { enabled: false },
    });
    instance.on("payment.failed", (res) => settle({ status: "failed", reason: res.error?.description ?? null }));
    instance.open();
  });
}
