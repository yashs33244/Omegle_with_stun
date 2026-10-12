/**
 * Country and network helpers for the session gate.
 *
 * The country comes only from Cloudflare's CF-IPCountry header, and only when
 * TRUST_CLOUDFLARE=true: without Cloudflare in front, anyone can send that
 * header, so it is ignored and the country is unknown (null).
 *
 * Trust assumption for the client IP (verified 2026-10-11 against a Render
 * web service that echoes its request headers): Render's edge is Cloudflare,
 * which overwrites a client-supplied `True-Client-IP` and `CF-IPCountry` and
 * answers 403 to a client-supplied `CF-Connecting-IP`; `X-Forwarded-For` is
 * append-only, so its first element is whatever the client sent, and
 * `X-Real-IP` is dropped. The compose gateway sets `X-Real-IP` itself
 * (deploy/nginx/proxy-headers.conf). So the configured header is only ever
 * trusted as a single IP literal; anything else falls back to the TCP peer.
 */
import { isIP, isIPv4, isIPv6 } from "node:net";
import type { Flags } from "../protocol";
import {
  COUNTRY_HEADER,
  IPV4_MAPPED_PREFIX,
  IPV4_NETWORK_OCTETS,
  IPV6_GROUPS,
  IPV6_NETWORK_GROUPS,
  IPV6_SUBSCRIBER_GROUPS,
  UNKNOWN_COUNTRY,
  UNKNOWN_IP,
} from "./constants";

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

/** ISO country code from CF-IPCountry, or null (untrusted, missing, "XX" unknown, "T1" Tor). */
export function requestCountry(headers: Headers, trustCloudflare: boolean): string | null {
  if (!trustCloudflare) return null;
  const value = header(headers, COUNTRY_HEADER)?.toUpperCase();
  if (!value || !/^[A-Z]{2}$/.test(value) || value === UNKNOWN_COUNTRY) return null;
  return value;
}

export function blockedCountries(flags: Flags): Set<string> {
  return new Set(flags.blocked_countries.split(",").filter((c) => c.length === 2));
}

export function isCountryBlocked(country: string | null, flags: Flags): boolean {
  return country !== null && blockedCountries(flags).has(country);
}

/**
 * A single IP literal, lower-cased, with the `::ffff:` prefix of IPv4-mapped
 * addresses and any IPv6 zone id (`%eth0`) removed; null for anything else.
 */
export function normalizeIp(value: string | undefined): string | null {
  if (!value) return null;
  const ip = value.trim().toLowerCase().split("%")[0]!;
  if (ip.startsWith(IPV4_MAPPED_PREFIX) && isIPv4(ip.slice(IPV4_MAPPED_PREFIX.length))) {
    return ip.slice(IPV4_MAPPED_PREFIX.length);
  }
  return isIP(ip) ? ip : null;
}

/**
 * Client IP: the configured proxy header (X-Real-IP from our gateway,
 * True-Client-IP on Render) when TRUST_PROXY is on and it holds one IP
 * literal, else the TCP peer. A header that is missing or is not an address
 * (a list, a hostname, junk) is never used as an identity.
 */
export function requestIp(headers: Headers, remoteAddress: string | undefined, proxyIpHeader: string | null): string {
  if (proxyIpHeader) {
    const real = normalizeIp(header(headers, proxyIpHeader));
    if (real) return real;
  }
  return normalizeIp(remoteAddress) ?? UNKNOWN_IP;
}

/** Expands an IPv6 address to IPV6_GROUPS groups of 4 hex digits. */
function expandIPv6(ip: string): string[] {
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail === undefined ? [] : new Array<string>(IPV6_GROUPS - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((g) => g.padStart(4, "0"));
}

/**
 * Rate-limit keys for an address: `ip` is one subscriber (an IPv4 address or
 * an IPv6 /64), `network` is the surrounding block (IPv4 /24, IPv6 /48).
 */
export function ipBuckets(rawIp: string): { ip: string; network: string } {
  let ip = rawIp.trim().toLowerCase();
  if (ip.startsWith(IPV4_MAPPED_PREFIX) && isIPv4(ip.slice(IPV4_MAPPED_PREFIX.length))) {
    ip = ip.slice(IPV4_MAPPED_PREFIX.length);
  }
  if (isIPv4(ip)) {
    return { ip, network: `${ip.split(".").slice(0, IPV4_NETWORK_OCTETS).join(".")}.0/24` };
  }
  if (isIPv6(ip)) {
    const groups = expandIPv6(ip.split("%")[0]!);
    return {
      ip: `${groups.slice(0, IPV6_SUBSCRIBER_GROUPS).join(":")}::/64`,
      network: `${groups.slice(0, IPV6_NETWORK_GROUPS).join(":")}::/48`,
    };
  }
  return { ip, network: ip };
}
