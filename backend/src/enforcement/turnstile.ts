/**
 * Cloudflare Turnstile verification for the public takedown form.
 * `fetch` is injected so tests never call Cloudflare.
 */

/** True when the token is valid for this request. Never throws. */
export type TurnstileVerifier = (token: string | undefined, ip: string | null) => Promise<boolean>;

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function createTurnstileVerifier(opts: {
  secret?: string;
  /** Without a secret: production refuses everything, development and tests accept everything. */
  production: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): TurnstileVerifier {
  const doFetch = opts.fetch ?? fetch;
  const secret = opts.secret;
  if (!secret) return async () => !opts.production;
  return async (token, ip) => {
    if (!token) return false;
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    try {
      const res = await doFetch(SITEVERIFY_URL, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { success?: unknown };
      return data.success === true;
    } catch {
      return false;
    }
  };
}
