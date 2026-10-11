/**
 * REST client for /api/billing (coins, Razorpay orders, premium unlocks).
 * Authenticated calls send the session token from POST /api/session as a
 * bearer; the server answers `{ ok: false, error }` with a BillingError.
 */
import { API_URL } from "@/lib/config";
import type {
  BillingOrder,
  BillingPacksResponse,
  BillingResponse,
  BillingUnlockRequest,
  BillingVerifyRequest,
  WalletView,
} from "@/lib/protocol";
import { ApiError } from "@/lib/api";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BillingApi {
  getPacks: () => Promise<BillingPacksResponse>;
  getWallet: (token: string) => Promise<BillingResponse<WalletView>>;
  createOrder: (token: string, packId: string) => Promise<BillingResponse<BillingOrder>>;
  verifyPayment: (token: string, req: BillingVerifyRequest) => Promise<BillingResponse<{ coins: number }>>;
  unlock: (token: string, req: BillingUnlockRequest) => Promise<BillingResponse<{ coins: number; expiresAt: number }>>;
}

const TIMEOUT_MS = 15_000;

function isBillingBody<T>(body: unknown): body is BillingResponse<T> {
  return typeof body === "object" && body !== null && "ok" in body && typeof body.ok === "boolean";
}

function isPacksBody(body: unknown): body is BillingPacksResponse {
  return typeof body === "object" && body !== null && "packs" in body && Array.isArray(body.packs);
}

export function createBillingApi(fetchImpl: FetchLike = (input, init) => fetch(input, init), base: string = API_URL): BillingApi {
  const root = `${base.replace(/\/+$/, "")}/api/billing`;

  async function request<T>(path: string, token: string | null, payload?: unknown): Promise<BillingResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, {
        method: payload === undefined ? "GET" : "POST",
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      throw new ApiError("Cannot reach the server", null);
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (isBillingBody<T>(body)) return body;
    if (res.status === 429) return { ok: false, error: "rate_limited" };
    throw new ApiError(`Unexpected answer from ${path}`, res.status);
  }

  return {
    async getPacks() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchImpl(`${root}/packs`, { signal: controller.signal, credentials: "omit", headers: { Accept: "application/json" } });
      } catch {
        throw new ApiError("Cannot reach the server", null);
      } finally {
        clearTimeout(timer);
      }
      const body: unknown = await res.json().catch(() => null);
      if (res.status !== 200 || !isPacksBody(body)) throw new ApiError("Could not load the coin packs", res.status);
      return body;
    },
    getWallet: (token) => request<WalletView>("/wallet", token),
    createOrder: (token, packId) => request<BillingOrder>("/orders", token, { packId }),
    verifyPayment: (token, req) => request<{ coins: number }>("/verify", token, req),
    unlock: (token, req) => request<{ coins: number; expiresAt: number }>("/unlock", token, req),
  };
}

export const billingApi: BillingApi = createBillingApi();
