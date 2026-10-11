/**
 * Under-18 lockouts, per-IP session rate limits and hourly match caps.
 *
 * Nothing here stores a raw IP address or fingerprint: keys are salted
 * SHA-256 HMACs, with the salt derived from SESSION_SECRET. Every salt in the
 * list is checked (current first, then previous) so lockouts survive a
 * secret rotation; writes use the current one.
 */
import { createHmac } from "node:crypto";
import {
  DEVICE_LOCKOUT_MS,
  FINGERPRINT_LOCKOUT_MS,
  KEY,
  MATCH_CAP_IP_BINDING_TTL_MS,
  MATCH_CAP_WINDOW_MS,
  SALT_DOMAIN,
  SESSION_RATE_WINDOW_MS,
} from "./constants";
import { ipBuckets } from "./geo";
import type { SessionKv } from "./SessionKv";

export function deriveSalt(secret: string, purpose: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", secret).update(`${SALT_DOMAIN}${purpose}`).digest());
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
      KEY.deviceLockout(saltedHash(salt, `device:${deviceId}`)),
      KEY.fingerprintLockout(saltedHash(salt, `fingerprint:${fingerprint}:${ipBuckets(ip).network}`)),
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
    const window = Math.floor(this.clock() / SESSION_RATE_WINDOW_MS);
    const [perIp, perNet] = await Promise.all([
      this.kv.incr(KEY.ipRate(saltedHash(this.salt, ip), window), SESSION_RATE_WINDOW_MS),
      this.kv.incr(KEY.networkRate(saltedHash(this.salt, network), window), SESSION_RATE_WINDOW_MS),
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
    return Math.floor(this.clock() / MATCH_CAP_WINDOW_MS);
  }

  async bindIp(deviceId: string, rawIp: string): Promise<void> {
    await this.kv.set(KEY.capIpOf(deviceId), saltedHash(this.salt, ipBuckets(rawIp).ip), MATCH_CAP_IP_BINDING_TTL_MS);
  }

  async overCap(deviceId: string): Promise<boolean> {
    const hour = this.hour();
    const ipHash = await this.kv.get(KEY.capIpOf(deviceId));
    const keys = [KEY.capDevice(deviceId, hour)];
    if (ipHash) keys.push(KEY.capIp(ipHash, hour));
    const [byDevice, byIp] = await this.kv.mget(keys);
    return Number(byDevice ?? 0) >= this.limits.perDevicePerHour || Number(byIp ?? 0) >= this.limits.perIpPerHour;
  }

  async recordMatch(deviceId: string): Promise<void> {
    const hour = this.hour();
    const ipHash = await this.kv.get(KEY.capIpOf(deviceId));
    await this.kv.incr(KEY.capDevice(deviceId, hour), MATCH_CAP_WINDOW_MS);
    if (ipHash) await this.kv.incr(KEY.capIp(ipHash, hour), MATCH_CAP_WINDOW_MS);
  }
}
