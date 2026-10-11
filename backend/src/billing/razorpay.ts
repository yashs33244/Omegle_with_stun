/**
 * Razorpay Orders API client and signature checks.
 *
 *   Orders:    POST https://api.razorpay.com/v1/orders, HTTP basic auth key_id:key_secret,
 *              amount in paise, receipt <= 40 chars, notes {deviceId, packId}.
 *   Checkout:  the success handler returns razorpay_signature =
 *              HMAC-SHA256(key_secret, `${order_id}|${payment_id}`), hex.
 *   Webhooks:  X-Razorpay-Signature = HMAC-SHA256(webhook_secret, raw body), hex.
 * Both MACs are compared in constant time.
 *
 * `FakeRazorpay` (RAZORPAY_FAKE=true, refused in production) answers without
 * HTTP so end-to-end tests run offline: orders are named order_fake_<nonce>
 * and the checkout signature FAKE_SIGNATURE is accepted for any payment.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const RAZORPAY_API = "https://api.razorpay.com/v1";
export const FAKE_KEY_ID = "rzp_test_fake";
export const FAKE_SIGNATURE = "fake-signature";

export interface RazorpayOrderInput {
  /** Paise. */
  amount: number;
  currency: "INR";
  receipt: string;
  notes: Record<string, string>;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  notes: Record<string, string>;
  status: string;
}

export class RazorpayError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface RazorpayGateway {
  readonly keyId: string;
  createOrder(input: RazorpayOrderInput): Promise<RazorpayOrder>;
  /** The order as Razorpay knows it, or null when it does not exist. */
  fetchOrder(orderId: string): Promise<RazorpayOrder | null>;
  /** razorpay_signature from Checkout. */
  verifyCheckout(orderId: string, paymentId: string, signature: string): boolean;
}

function hmacHex(secret: string, body: string | Buffer): string {
  return createHmac("sha256", secret)
    .update(typeof body === "string" ? body : new Uint8Array(body))
    .digest("hex");
}

/** Constant-time hex MAC compare; false for anything that is not the right length. */
export function macEquals(expectedHex: string, givenHex: string): boolean {
  if (!/^[0-9a-f]+$/i.test(givenHex) || givenHex.length !== expectedHex.length) return false;
  return timingSafeEqual(new Uint8Array(Buffer.from(expectedHex, "hex")), new Uint8Array(Buffer.from(givenHex, "hex")));
}

export function checkoutSignature(keySecret: string, orderId: string, paymentId: string): string {
  return hmacHex(keySecret, `${orderId}|${paymentId}`);
}

export function verifyCheckoutSignature(keySecret: string, orderId: string, paymentId: string, signature: string): boolean {
  return macEquals(checkoutSignature(keySecret, orderId, paymentId), signature);
}

export function webhookSignature(webhookSecret: string, rawBody: Buffer | string): string {
  return hmacHex(webhookSecret, rawBody);
}

export function verifyWebhookSignature(webhookSecret: string, rawBody: Buffer | string, signature: string | undefined): boolean {
  return typeof signature === "string" && macEquals(webhookSignature(webhookSecret, rawBody), signature);
}

export class RazorpayClient implements RazorpayGateway {
  private readonly auth: string;

  constructor(
    readonly keyId: string,
    private readonly keySecret: string,
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
    private readonly base = RAZORPAY_API,
  ) {
    this.auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  }

  async createOrder(input: RazorpayOrderInput): Promise<RazorpayOrder> {
    const res = await this.request("POST", "/orders", input);
    if (!res.ok) throw new RazorpayError(`razorpay order failed with ${res.status}`, res.status);
    return (await res.json()) as RazorpayOrder;
  }

  async fetchOrder(orderId: string): Promise<RazorpayOrder | null> {
    const res = await this.request("GET", `/orders/${encodeURIComponent(orderId)}`);
    if (res.status === 400 || res.status === 404) return null;
    if (!res.ok) throw new RazorpayError(`razorpay order lookup failed with ${res.status}`, res.status);
    return (await res.json()) as RazorpayOrder;
  }

  verifyCheckout(orderId: string, paymentId: string, signature: string): boolean {
    return verifyCheckoutSignature(this.keySecret, orderId, paymentId, signature);
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: { authorization: this.auth, "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new RazorpayError(`razorpay unreachable: ${err instanceof Error ? err.message : String(err)}`, null);
    }
  }
}

/** Test-only gateway: no network, remembers its orders, accepts FAKE_SIGNATURE. */
export class FakeRazorpay implements RazorpayGateway {
  readonly keyId = FAKE_KEY_ID;
  private readonly orders = new Map<string, RazorpayOrder>();

  async createOrder(input: RazorpayOrderInput): Promise<RazorpayOrder> {
    const order: RazorpayOrder = {
      id: `order_fake_${randomBytes(7).toString("hex")}`,
      amount: input.amount,
      currency: input.currency,
      receipt: input.receipt,
      notes: { ...input.notes },
      status: "created",
    };
    this.orders.set(order.id, order);
    return { ...order };
  }

  async fetchOrder(orderId: string): Promise<RazorpayOrder | null> {
    const order = this.orders.get(orderId);
    return order ? { ...order } : null;
  }

  verifyCheckout(_orderId: string, _paymentId: string, signature: string): boolean {
    return signature === FAKE_SIGNATURE;
  }
}
