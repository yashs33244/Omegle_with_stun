/**
 * Cloudflare Turnstile verification for the public takedown form: a boolean
 * wrapper around the session gate's verifier (session/turnstile.ts), which
 * fails closed and never throws. `fetch` is injected so tests never call Cloudflare.
 */
import { verifyTurnstile, type FetchLike } from "../session/turnstile";

/** True when the token is valid for this request. Never throws. */
export type TurnstileVerifier = (token: string | undefined, ip: string | null) => Promise<boolean>;

export function createTurnstileVerifier(opts: {
  secret?: string;
  /** Without a secret: production refuses everything, development and tests accept everything. */
  production: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): TurnstileVerifier {
  const secret = opts.secret;
  if (!secret) return async () => !opts.production;
  const doFetch: FetchLike = opts.fetch ?? fetch;
  return async (token, ip) => {
    const result = await verifyTurnstile({
      secret,
      token,
      remoteIp: ip ?? undefined,
      fetch: doFetch,
      timeoutMs: opts.timeoutMs,
    });
    return result.success;
  };
}
