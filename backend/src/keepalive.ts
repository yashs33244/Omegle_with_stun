/**
 * Keep-alive for hosts that idle out free instances. Render spins a Free web
 * service down after 15 minutes without inbound traffic and takes about a
 * minute to come back, which would strand the first caller on a loading page.
 * A request to the service's own public URL counts as inbound traffic, so
 * this GETs KEEPALIVE_URL (default: the Render /healthz) every 10 minutes.
 *
 * It is a complement to the external pinger in .github/workflows/keepalive.yml:
 * this one cannot wake a process that is already asleep, the workflow can.
 * Failures are logged and retried next tick; nothing else depends on it.
 */
import type { Logger } from "./logger";

export const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface KeepaliveDeps {
  url: string;
  logger: Logger;
  intervalMs?: number;
  fetch?: typeof fetch;
}

/** Starts pinging; the returned function stops it. The timer never keeps the process alive. */
export function startKeepalive(deps: KeepaliveDeps): () => void {
  const doFetch = deps.fetch ?? fetch;
  const ping = async () => {
    try {
      const res = await doFetch(deps.url, { method: "GET", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) deps.logger.warn({ url: deps.url, status: res.status }, "keep-alive ping was not ok");
    } catch (err) {
      deps.logger.warn({ err, url: deps.url }, "keep-alive ping failed");
    }
  };
  const timer = setInterval(() => void ping(), deps.intervalMs ?? KEEPALIVE_INTERVAL_MS);
  timer.unref();
  deps.logger.info({ url: deps.url, intervalMs: deps.intervalMs ?? KEEPALIVE_INTERVAL_MS }, "keep-alive pings enabled");
  return () => clearInterval(timer);
}
