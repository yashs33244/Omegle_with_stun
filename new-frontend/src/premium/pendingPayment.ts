/**
 * A paid Checkout whose POST /verify has not answered ok yet.
 *
 * The proof of payment {orderId, paymentId, signature} is kept in
 * localStorage until the server credits it or refuses it for good, so a rate
 * limit, a dropped connection, an authorized-but-not-captured payment or a
 * closed tab cannot lose it. `settlePendingPayment` retries with backoff
 * (2 s, 4 s, ... capped at 60 s) for up to ten minutes after the payment;
 * PremiumProvider runs it after a purchase and again on the next app load.
 * The webhook credits independently, so giving up never loses coins.
 */
import { ApiError } from "@/lib/api";
import type { BillingApi } from "@/lib/billingApi";
import type { BillingError, BillingVerifyRequest } from "@/lib/protocol";
import { ERROR_KEYS, type PremiumErrorKey } from "./PremiumContext";

export const PENDING_PAYMENT_KEY = "chizzy.pendingPayment";
export const PENDING_GIVE_UP_MS = 10 * 60_000;
export const PENDING_MAX_DELAY_MS = 60_000;

export interface PendingPayment extends BillingVerifyRequest {
  /** Epoch ms of the Checkout success; retries stop PENDING_GIVE_UP_MS later. */
  startedAt: number;
}

/** Answers after which /verify will never credit this payment. */
const TERMINAL: Record<BillingError, boolean> = {
  billing_disabled: false,
  session_required: false,
  invalid: true,
  rate_limited: false,
  unknown_pack: true,
  order_unknown: true,
  bad_signature: true,
  payment_mismatch: true,
  payment_pending: false,
  insufficient_coins: true,
  upstream: false,
};

export type VerifyAttempt =
  | { status: "ok"; coins: number }
  | { status: "retry"; error: PremiumErrorKey }
  | { status: "failed"; error: PremiumErrorKey };

function isPendingPayment(value: unknown): value is PendingPayment {
  if (typeof value !== "object" || value === null) return false;
  if (!("orderId" in value && "paymentId" in value && "signature" in value && "startedAt" in value)) return false;
  return (
    typeof value.orderId === "string" &&
    typeof value.paymentId === "string" &&
    typeof value.signature === "string" &&
    typeof value.startedAt === "number"
  );
}

export function loadPendingPayment(): PendingPayment | null {
  try {
    const raw = localStorage.getItem(PENDING_PAYMENT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPendingPayment(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function savePendingPayment(payment: PendingPayment): void {
  try {
    localStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify(payment));
  } catch {
    // Private mode or a full quota: the retry loop still runs for this page.
  }
}

export function clearPendingPayment(): void {
  try {
    localStorage.removeItem(PENDING_PAYMENT_KEY);
  } catch {
    // nothing to clear
  }
}

/** One POST /verify, classified: credited, worth retrying, or refused for good. */
export async function attemptVerify(api: BillingApi, token: string, payment: BillingVerifyRequest): Promise<VerifyAttempt> {
  const { orderId, paymentId, signature } = payment;
  let res;
  try {
    res = await api.verifyPayment(token, { orderId, paymentId, signature });
  } catch (err) {
    // A wrong-shaped answer is a server bug; everything else is the network.
    return { status: "retry", error: err instanceof ApiError && err.status !== null ? "generic" : "unreachable" };
  }
  if (res.ok) return { status: "ok", coins: res.coins };
  const error = res.error === "payment_pending" ? "paymentPending" : ERROR_KEYS[res.error];
  return { status: TERMINAL[res.error] ? "failed" : "retry", error };
}

export function retryDelay(attempt: number): number {
  return Math.min(2_000 * 2 ** attempt, PENDING_MAX_DELAY_MS);
}

export interface SettleDeps {
  api: BillingApi;
  getToken: () => string | null;
  /** The caller just tried once and got a retryable answer: start with the first back-off instead of another attempt. */
  alreadyTried?: boolean;
  now?: () => number;
}

export interface SettleHandle {
  /** Resolves with the final attempt; "retry" means the ten minutes ran out or it was cancelled. */
  done: Promise<VerifyAttempt>;
  cancel: () => void;
}

/**
 * Retries /verify for `payment` until it answers ok or a terminal error, or
 * PENDING_GIVE_UP_MS have passed since the payment. The stored record is
 * cleared on every outcome except cancel, so a reload after the deadline does
 * not start again.
 */
export function settlePendingPayment(payment: PendingPayment, deps: SettleDeps): SettleHandle {
  const now = deps.now ?? Date.now;
  let cancelled = false;
  let wake: (() => void) | null = null;
  const cancel = () => {
    cancelled = true;
    wake?.();
  };
  const done = (async (): Promise<VerifyAttempt> => {
    let last: VerifyAttempt = { status: "retry", error: "paymentPending" };
    // Back-off step: the caller's own attempt, if any, counts as the first.
    let step = deps.alreadyTried ? 0 : -1;
    for (;;) {
      if (step >= 0) {
        if (now() - payment.startedAt >= PENDING_GIVE_UP_MS) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, retryDelay(step));
        });
        wake = null;
        if (cancelled) break;
      }
      const token = deps.getToken();
      last = token ? await attemptVerify(deps.api, token, payment) : { status: "retry", error: "sessionRequired" };
      if (last.status !== "retry" || cancelled) break;
      step++;
    }
    if (!cancelled) clearPendingPayment();
    return last;
  })();
  return { done, cancel };
}
