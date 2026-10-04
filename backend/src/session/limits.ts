/**
 * Under-18 lockouts, per-IP session rate limits and hourly match caps.
 *
 * Nothing here stores a raw IP address or fingerprint: keys are salted
 * SHA-256 HMACs, with the salt derived from SESSION_SECRET. Every salt in the
 * list is checked (current first, then previous) so lockouts survive a
 * secret rotation; writes use the current one.
 */
import { createHmac } from "node:crypto";
import { ipBuckets } from "./geo";
import type { SessionKv } from "./kv";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;

/** A device that proved it is under 18 stays locked out for a year. */
export const DEVICE_LOCKOUT_MS = 365 * DAY_MS;
/**
 * The fingerprint is coarse (many phones of one model share it), so it is only
 * used together with the network block, and for a shorter time, to keep
 * strangers on the same carrier from being locked out with the child.
 */
export const FINGERPRINT_LOCKOUT_MS = 30 * DAY_MS;

export function deriveSalt(secret: string, purpose: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", secret).update(`chizzy:salt:${purpose}`).digest());
}

/** Salted SHA-256 HMAC, hex. */
export function saltedHash(salt: Uint8Array, value: string): string {
  return createHmac("sha256", salt).update(value).digest("hex");
}

/** Today's date in UTC, the only thing stored with a lockout. */
function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class Lockout {
  constructor(
    private readonly kv: SessionKv,
    private readonly salts: Uint8Array[],
    private readonly clock: () => number = Date.now,
  ) {}

  private keys(salt: Uint8Array, deviceId: string, fingerprint: string, ip: string): [string, string] {
    return [
      `lock:d:${saltedHash(salt, `device:${deviceId}`)}`,
      `lock:f:${saltedHash(salt, `fingerprint:${fingerprint}:${ipBuckets(ip).network}`)}`,
    ];
  }

  async isLocked(deviceId: string, fingerprint: string, ip: string): Promise<boolean> {
    const keys = this.salts.flatMap((salt) => this.keys(salt, deviceId, fingerprint, ip));
    return (await this.kv.mget(keys)).some((v) => v !== null);
  }

  async lock(deviceId: string, fingerprint: string, ip: string): Promise<void> {
    const [device, fp] = this.keys(this.salts[0]!, deviceId, fingerprint, ip);
    const date = utcDate(this.clock());
    await this.kv.set(device, date, DEVICE_LOCKOUT_MS);
    await this.kv.set(fp, date, FINGERPRINT_LOCKOUT_MS);
  }
}

export interface SessionRateLimits {
  perIpPerMinute: number;
  perNetworkPerMinute: number;
}

/** Fixed one-minute windows per IP and per /24 (IPv6 /48). */
export class SessionRateLimiter {
  constructor(
    private readonly kv: SessionKv,
    private readonly salt: Uint8Array,
    private readonly limits: SessionRateLimits,
    private readonly clock: () => number = Date.now,
  ) {}

  async allow(rawIp: string): Promise<boolean> {
    const { ip, network } = ipBuckets(rawIp);
    const window = Math.floor(this.clock() / MINUTE_MS);
    const [perIp, perNet] = await Promise.all([
      this.kv.incr(`rl:ip:${saltedHash(this.salt, ip)}:${window}`, MINUTE_MS),
      this.kv.incr(`rl:net:${saltedHash(this.salt, network)}:${window}`, MINUTE_MS),
    ]);
    return perIp <= this.limits.perIpPerMinute && perNet <= this.limits.perNetworkPerMinute;
  }
}

export interface MatchCapLimits {
  perDevicePerHour: number;
  perIpPerHour: number;
}

/**
 * Hourly match caps (LB-10): a level no human reaches, so scripted clients
 * cannot harvest faces and IPs. The handshake binds each device to its IP;
 * every match then counts against both.
 */
export class MatchCaps {
  constructor(
    private readonly kv: SessionKv,
    private readonly salt: Uint8Array,
    private readonly limits: MatchCapLimits,
    private readonly clock: () => number = Date.now,
  ) {}

  private hour(): number {
    return Math.floor(this.clock() / HOUR_MS);
  }

  async bindIp(deviceId: string, rawIp: string): Promise<void> {
    await this.kv.set(`cap:ipof:${deviceId}`, saltedHash(this.salt, ipBuckets(rawIp).ip), DAY_MS);
  }

  async overCap(deviceId: string): Promise<boolean> {
    const hour = this.hour();
    const ipHash = await this.kv.get(`cap:ipof:${deviceId}`);
    const keys = [`cap:d:${deviceId}:${hour}`];
    if (ipHash) keys.push(`cap:i:${ipHash}:${hour}`);
    const [byDevice, byIp] = await this.kv.mget(keys);
    return Number(byDevice ?? 0) >= this.limits.perDevicePerHour || Number(byIp ?? 0) >= this.limits.perIpPerHour;
  }

  async recordMatch(deviceId: string): Promise<void> {
    const hour = this.hour();
    const ipHash = await this.kv.get(`cap:ipof:${deviceId}`);
    await this.kv.incr(`cap:d:${deviceId}:${hour}`, HOUR_MS);
    if (ipHash) await this.kv.incr(`cap:i:${ipHash}:${hour}`, HOUR_MS);
  }
}
