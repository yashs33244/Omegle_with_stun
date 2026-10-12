/**
 * REST client for the public API (same origin as the socket server).
 * Request and response shapes come from protocol.ts; the server validates
 * every request again, so the client only checks what it needs to render.
 */
import { parseRetryAfter } from "@/lib/backoff";
import { API_URL } from "@/lib/config";
import type {
  AppealRequest,
  AppealResponse,
  PublicConfig,
  RestrictionView,
  SessionRequest,
  SessionResponse,
  TakedownRequest,
  TakedownResponse,
} from "@/lib/protocol";

/** The request never got a usable answer (offline, server down, unexpected body). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * POST /api/session's answer. A transient refusal (`closed` on overload,
 * `rate_limited`) may carry the server's Retry-After, in milliseconds.
 */
export type SessionReply =
  | Extract<SessionResponse, { ok: true }>
  | (Extract<SessionResponse, { ok: false }> & { retryAfterMs?: number });

export interface Api {
  getConfig: () => Promise<PublicConfig>;
  createSession: (req: SessionRequest) => Promise<SessionReply>;
  getRestriction: (id: string, deviceId: string) => Promise<RestrictionView | null>;
  submitAppeal: (req: AppealRequest) => Promise<AppealResponse>;
  submitTakedown: (req: TakedownRequest) => Promise<TakedownResponse>;
}

const TIMEOUT_MS = 15_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Answers with `{ ok }` bodies come back as data whatever the HTTP status (a 403 still says why). */
function isOkBody<T>(body: unknown): body is T {
  return isObject(body) && typeof body.ok === "boolean";
}

export function createApi(fetchImpl: FetchLike = (input, init) => fetch(input, init), base: string = API_URL): Api {
  const root = base.replace(/\/+$/, "");

  async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; retryAfterMs: number | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, {
        ...init,
        signal: controller.signal,
        credentials: "omit",
        headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
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
    return { status: res.status, body, retryAfterMs: parseRetryAfter(res.headers.get("Retry-After")) };
  }

  /** POST endpoints whose answer is `{ ok: true, ... } | { ok: false, error }`. */
  async function post<T>(path: string, payload: unknown): Promise<T> {
    const { status, body } = await request(path, { method: "POST", body: JSON.stringify(payload) });
    if (isOkBody<T>(body)) return body;
    if (status === 429) return { ok: false, error: "rate_limited" } as T;
    throw new ApiError(`Unexpected answer from ${path}`, status);
  }

  return {
    async getConfig() {
      const { status, body } = await request("/api/config");
      if (status !== 200 || !isObject(body) || typeof body.tosVersion !== "string") {
        throw new ApiError("Could not load the configuration", status);
      }
      return body as unknown as PublicConfig;
    },

    async createSession(req) {
      const { status, body, retryAfterMs } = await request("/api/session", { method: "POST", body: JSON.stringify(req) });
      let reply: SessionReply;
      if (isOkBody<SessionResponse>(body)) reply = body;
      else if (status === 429) reply = { ok: false, error: "rate_limited" };
      else throw new ApiError("Unexpected answer from /api/session", status);
      return !reply.ok && retryAfterMs !== null ? { ...reply, retryAfterMs } : reply;
    },

    async getRestriction(id, deviceId) {
      const { status, body } = await request(
        `/api/restrictions/${encodeURIComponent(id)}?deviceId=${encodeURIComponent(deviceId)}`,
      );
      if (status === 404) return null;
      if (status !== 200 || !isObject(body) || !isObject(body.restriction)) {
        throw new ApiError("Could not load the restriction", status);
      }
      return body as unknown as RestrictionView;
    },

    submitAppeal: (req) => post<AppealResponse>("/api/appeals", req),

    submitTakedown: (req) => post<TakedownResponse>("/api/takedowns", req),
  };
}

export const api: Api = createApi();
