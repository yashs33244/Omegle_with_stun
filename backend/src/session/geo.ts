/**
 * Country and network helpers for the session gate.
 *
 * The country comes only from Cloudflare's CF-IPCountry header, and only when
 * TRUST_CLOUDFLARE=true: without Cloudflare in front, anyone can send that
 * header, so it is ignored and the country is unknown (null).
 */
import { isIPv4, isIPv6 } from "node:net";
import type { Flags } from "../protocol";

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

/** ISO country code from CF-IPCountry, or null (untrusted, missing, "XX" unknown, "T1" Tor). */
export function requestCountry(headers: Headers, trustCloudflare: boolean): string | null {
  if (!trustCloudflare) return null;
  const value = header(headers, "cf-ipcountry")?.toUpperCase();
  if (!value || !/^[A-Z]{2}$/.test(value) || value === "XX") return null;
  return value;
}

export function blockedCountries(flags: Flags): Set<string> {
  return new Set(flags.blocked_countries.split(",").filter((c) => c.length === 2));
}

export function isCountryBlocked(country: string | null, flags: Flags): boolean {
  return country !== null && blockedCountries(flags).has(country);
}

/**
 * Client IP: the configured proxy header (X-Real-IP from our gateway,
 * True-Client-IP on Render) when TRUST_PROXY is on, else the TCP peer.
 */
export function requestIp(headers: Headers, remoteAddress: string | undefined, proxyIpHeader: string | null): string {
  if (proxyIpHeader) {
    const real = header(headers, proxyIpHeader);
    if (real) return real;
  }
  return remoteAddress ?? "unknown";
}

/** Expands an IPv6 address to 8 groups of 4 hex digits. */
function expandIPv6(ip: string): string[] {
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail === undefined ? [] : new Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((g) => g.padStart(4, "0"));
}

/**
 * Rate-limit keys for an address: `ip` is one subscriber (an IPv4 address or
 * an IPv6 /64), `network` is the surrounding block (IPv4 /24, IPv6 /48).
 */
export function ipBuckets(rawIp: string): { ip: string; network: string } {
  let ip = rawIp.trim().toLowerCase();
  if (ip.startsWith("::ffff:") && isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (isIPv4(ip)) {
    return { ip, network: `${ip.split(".").slice(0, 3).join(".")}.0/24` };
  }
  if (isIPv6(ip)) {
    const groups = expandIPv6(ip.split("%")[0]!);
    return { ip: `${groups.slice(0, 4).join(":")}::/64`, network: `${groups.slice(0, 3).join(":")}::/48` };
  }
  return { ip, network: ip };
}
