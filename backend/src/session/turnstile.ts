/**
 * Cloudflare Turnstile server-side validation (Siteverify).
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 *
 * Fails closed: a network error, timeout or odd response counts as a failure.
 */
export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type FetchLike = (input: string, init: { method: string; body: URLSearchParams; signal: AbortSignal }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

export interface TurnstileResult {
  success: boolean;
  /** Cloudflare error codes, or a local one ("missing-input-response", "network-error", "bad-response"). */
  errors: string[];
}

export async function verifyTurnstile(opts: {
  secret: string;
  token: string | undefined;
  remoteIp?: string;
  fetch: FetchLike;
  timeoutMs?: number;
}): Promise<TurnstileResult> {
  if (!opts.token) return { success: false, errors: ["missing-input-response"] };
  const body = new URLSearchParams({ secret: opts.secret, response: opts.token });
  if (opts.remoteIp) body.set("remoteip", opts.remoteIp);
  let data: unknown;
  try {
    const res = await opts.fetch(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (!res.ok) return { success: false, errors: ["bad-response"] };
    data = await res.json();
  } catch {
    return { success: false, errors: ["network-error"] };
  }
  if (typeof data !== "object" || data === null) return { success: false, errors: ["bad-response"] };
  const d = data as { success?: unknown; "error-codes"?: unknown };
  const errors = Array.isArray(d["error-codes"]) ? d["error-codes"].filter((e): e is string => typeof e === "string") : [];
  return { success: d.success === true, errors };
}
