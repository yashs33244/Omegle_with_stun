/**
 * Cloudflare Turnstile server-side validation (Siteverify).
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 *
 * Fails closed: a network error, timeout or odd response counts as a failure.
 * Shared by the session gate and the takedown form (enforcement/turnstile.ts).
 */
import { SITEVERIFY_URL, TURNSTILE_LOCAL_ERROR, TURNSTILE_TIMEOUT_MS } from "./constants";

export type FetchLike = (input: string, init: { method: string; body: URLSearchParams; signal: AbortSignal }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

export interface TurnstileResult {
  success: boolean;
  /** Cloudflare error codes, or a local one (TURNSTILE_LOCAL_ERROR). */
  errors: string[];
}

export async function verifyTurnstile(opts: {
  secret: string;
  token: string | undefined;
  remoteIp?: string;
  fetch: FetchLike;
  timeoutMs?: number;
}): Promise<TurnstileResult> {
  if (!opts.token) return { success: false, errors: [TURNSTILE_LOCAL_ERROR.missingToken] };
  const body = new URLSearchParams({ secret: opts.secret, response: opts.token });
  if (opts.remoteIp) body.set("remoteip", opts.remoteIp);
  let data: unknown;
  try {
    const res = await opts.fetch(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? TURNSTILE_TIMEOUT_MS),
    });
    if (!res.ok) return { success: false, errors: [TURNSTILE_LOCAL_ERROR.badResponse] };
    data = await res.json();
  } catch {
    return { success: false, errors: [TURNSTILE_LOCAL_ERROR.networkError] };
  }
  if (typeof data !== "object" || data === null) return { success: false, errors: [TURNSTILE_LOCAL_ERROR.badResponse] };
  const d = data as { success?: unknown; "error-codes"?: unknown };
  const errors = Array.isArray(d["error-codes"]) ? d["error-codes"].filter((e): e is string => typeof e === "string") : [];
  return { success: d.success === true, errors };
}
