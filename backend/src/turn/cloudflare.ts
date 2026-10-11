/**
 * Cloudflare Realtime TURN: short-lived credentials from the
 * generate-ice-servers API (https://developers.cloudflare.com/realtime/turn/generate-credentials/).
 *
 * Port 53 URLs are dropped: browsers block that port and it only slows ICE down.
 * turns:443 (TLS over TCP 443) is kept, it is what gets through strict networks.
 */
import type { IceServer } from "../protocol";
import { BLOCKED_ICE_PORT, CLOUDFLARE_TURN_API_BASE, CLOUDFLARE_TURN_TIMEOUT_MS } from "./constants";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface CloudflareTurnOptions {
  keyId: string;
  apiToken: string;
  ttlSeconds: number;
  fetch: FetchFn;
  timeoutMs?: number;
}

export function cloudflareTurnUrl(keyId: string): string {
  return `${CLOUDFLARE_TURN_API_BASE}${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
}

const BLOCKED_PORT_RE = new RegExp(String.raw`^(stuns?|turns?):[^?]*:${BLOCKED_ICE_PORT}(\?|$)`, "i");

/** True for stun:/turn: URLs on the blocked port, e.g. "turn:turn.cloudflare.com:53?transport=udp". */
export function isPort53(url: string): boolean {
  return BLOCKED_PORT_RE.test(url);
}

/** Removes port 53 URLs and any server left without URLs. */
export function dropPort53(servers: IceServer[]): IceServer[] {
  const out: IceServer[] = [];
  for (const server of servers) {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((u) => !isPort53(u));
    if (urls.length > 0) out.push({ ...server, urls });
  }
  return out;
}

function asIceServer(value: unknown): IceServer | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const urls = typeof v.urls === "string" ? [v.urls] : Array.isArray(v.urls) ? v.urls.filter((u) => typeof u === "string") : [];
  if (urls.length === 0) return null;
  const server: IceServer = { urls: urls as string[] };
  if (typeof v.username === "string") server.username = v.username;
  if (typeof v.credential === "string") server.credential = v.credential;
  return server;
}

/**
 * Calls the API and returns the relay servers (port 53 dropped). Throws on
 * HTTP errors, timeouts or a response without a credentialed TURN server.
 */
export async function fetchCloudflareIceServers(opts: CloudflareTurnOptions): Promise<IceServer[]> {
  const res = await opts.fetch(cloudflareTurnUrl(opts.keyId), {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: opts.ttlSeconds }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? CLOUDFLARE_TURN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`cloudflare turn api returned ${res.status}`);
  const body = (await res.json()) as { iceServers?: unknown };
  // The API answers with an array; older versions sent a single object.
  const raw = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
  const servers = dropPort53(raw.map(asIceServer).filter((s): s is IceServer => s !== null));
  if (!servers.some((s) => s.username && s.credential)) throw new Error("cloudflare turn api returned no TURN credentials");
  return servers;
}
