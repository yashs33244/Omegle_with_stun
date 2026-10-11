import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { describeStaffedHours } from "../../src/flags/flags";
import { ageInYears } from "../../src/session/age";
import { ipBuckets, isCountryBlocked, requestCountry, requestIp } from "../../src/session/geo";
import { MemoryKv, RedisKv, type SessionKv } from "../../src/session/kv";
import {
  DEVICE_LOCKOUT_MS,
  FINGERPRINT_LOCKOUT_MS,
  Lockout,
  MatchCaps,
  SessionRateLimiter,
  deriveSalt,
} from "../../src/session/limits";
import { TokenSigner } from "../../src/session/tokens";
import { SITEVERIFY_URL, verifyTurnstile, type FetchLike } from "../../src/session/turnstile";
import { FLAG_DEFAULTS, TOS_VERSION } from "../../src/protocol";
import pino from "pino";
import { FlagsReader, MemoryFlagsStore } from "../../src/flags/flags";
import { SessionService } from "../../src/session/SessionService";

describe("SessionService privacy", () => {
  test("never logs or returns the date of birth, even when it locks a device out", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "trace" }, { write: (l: string) => lines.push(l) });
    const kv = new MemoryKv();
    const service = new SessionService({
      tokens: new TokenSigner([SECRET]),
      flags: new FlagsReader(new MemoryFlagsStore()),
      lockout: new Lockout(kv, [deriveSalt(SECRET, "lockout")]),
      rateLimiter: new SessionRateLimiter(kv, deriveSalt(SECRET, "x"), { perIpPerMinute: 100, perNetworkPerMinute: 100 }),
      logger,
      turnstileSecret: "secret",
      fetch: async () => ({ ok: true, json: async () => ({ success: true }) }),
    });
    const dob = "2015-07-19";
    const res = await service.create(
      { deviceId: randomUUID(), fingerprint: "b".repeat(64), turnstileToken: "t", age: { dob, attest18: true, tosVersion: TOS_VERSION } },
      { ip: "203.0.113.9", country: null },
    );
    expect(res.body).toEqual({ ok: false, error: "underage" });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(dob);
    expect(lines.join("\n")).not.toContain("203.0.113.9");
  });
});

const SECRET = "a".repeat(32);
const OLD_SECRET = "b".repeat(32);
const NOW = Date.UTC(2026, 9, 4, 12, 0);

describe("tokens", () => {
  const session = (over = {}) => ({
    kind: "session" as const,
    deviceId: randomUUID(),
    country: "IN",
    iat: NOW,
    exp: NOW + 1000,
    ...over,
  });

  test("round-trip and kind separation", () => {
    const signer = new TokenSigner([SECRET]);
    const payload = session();
    const token = signer.sign(payload);
    expect(token.startsWith("c1.")).toBe(true);
    expect(signer.verifySession(token, NOW)).toEqual(payload);
    // A session token is not an age token.
    expect(signer.verifyAge(token, NOW)).toBeNull();
  });

  test("expired, tampered, foreign and malformed tokens fail", () => {
    const signer = new TokenSigner([SECRET]);
    const token = signer.sign(session());
    expect(signer.verifySession(token, NOW + 1000)).toBeNull();
    const [p, body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...session(), exp: NOW + 10 ** 9 })).toString("base64url");
    expect(signer.verifySession(`${p}.${forged}.${mac}`, NOW)).toBeNull();
    expect(signer.verifySession(`${p}.${body}.${mac}x`, NOW)).toBeNull();
    expect(signer.verifySession(`${p}.${body}.${mac}!`, NOW)).toBeNull();
    expect(new TokenSigner([OLD_SECRET]).verifySession(token, NOW)).toBeNull();
    for (const bad of [undefined, 42, "", "c1", "c1.a.b", "x".repeat(5000), `c2.${body}.${mac}`]) {
      expect(signer.verifySession(bad, NOW)).toBeNull();
    }
  });

  test("rotation: tokens signed with the previous secret still verify; new ones use the current", () => {
    const old = new TokenSigner([OLD_SECRET]).sign(session());
    const rotated = new TokenSigner([SECRET, OLD_SECRET]);
    expect(rotated.verifySession(old, NOW)).not.toBeNull();
    const fresh = rotated.sign(session());
    expect(new TokenSigner([SECRET]).verifySession(fresh, NOW)).not.toBeNull();
    expect(new TokenSigner([OLD_SECRET]).verifySession(fresh, NOW)).toBeNull();
  });

  test("age tokens carry the outcome only", () => {
    const signer = new TokenSigner([SECRET]);
    const token = signer.sign({ kind: "age", deviceId: randomUUID(), over18: true, tosVersion: "v1", iat: NOW, exp: NOW + 5 });
    const decoded = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    expect(Object.keys(decoded).sort()).toEqual(["deviceId", "exp", "iat", "kind", "over18", "tosVersion"]);
    expect(signer.verifyAge(token, NOW)?.over18).toBe(true);
    expect(signer.verifySession(token, NOW)).toBeNull();
  });
});

describe("age", () => {
  test("turns 18 at 00:00 UTC on the 18th birthday", () => {
    expect(ageInYears("2008-10-04", Date.UTC(2026, 9, 4, 0, 0, 0))).toBe(18);
    expect(ageInYears("2008-10-04", Date.UTC(2026, 9, 3, 23, 59, 59))).toBe(17);
    expect(ageInYears("2008-10-05", Date.UTC(2026, 9, 4, 23, 59, 59))).toBe(17);
  });

  test("29 February birthdays count from 1 March in common years", () => {
    expect(ageInYears("2008-02-29", Date.UTC(2026, 1, 28))).toBe(17);
    expect(ageInYears("2008-02-29", Date.UTC(2026, 2, 1))).toBe(18);
  });

  test("rejects future dates, dates before 1900 and impossible dates", () => {
    expect(ageInYears("2026-10-05", NOW)).toBeNull();
    expect(ageInYears("1899-12-31", NOW)).toBeNull();
    expect(ageInYears("1900-01-01", NOW)).toBe(126);
    expect(ageInYears("2001-02-30", NOW)).toBeNull();
    expect(ageInYears("2001-13-01", NOW)).toBeNull();
    expect(ageInYears("01-01-2001", NOW)).toBeNull();
    expect(ageInYears("2026-10-04", NOW)).toBe(0);
  });
});

describe("geo", () => {
  test("CF-IPCountry only counts when Cloudflare is trusted", () => {
    expect(requestCountry({ "cf-ipcountry": "GB" }, false)).toBeNull();
    expect(requestCountry({ "cf-ipcountry": "GB" }, true)).toBe("GB");
    expect(requestCountry({ "cf-ipcountry": "in" }, true)).toBe("IN");
    expect(requestCountry({ "cf-ipcountry": "XX" }, true)).toBeNull();
    expect(requestCountry({ "cf-ipcountry": "T1" }, true)).toBeNull();
    expect(requestCountry({}, true)).toBeNull();
  });

  test("blocklist from flags; unknown countries are not blocked", () => {
    const flags = { ...FLAG_DEFAULTS };
    expect(isCountryBlocked("GB", flags)).toBe(true);
    expect(isCountryBlocked("DE", flags)).toBe(true);
    expect(isCountryBlocked("US", flags)).toBe(false);
    expect(isCountryBlocked(null, flags)).toBe(false);
    expect(isCountryBlocked("GB", { ...flags, blocked_countries: "" })).toBe(false);
  });

  test("X-Real-IP only behind the trusted proxy", () => {
    expect(requestIp({ "x-real-ip": "1.2.3.4" }, "10.0.0.1", false)).toBe("10.0.0.1");
    expect(requestIp({ "x-real-ip": "1.2.3.4" }, "10.0.0.1", true)).toBe("1.2.3.4");
  });

  test("ip and network buckets", () => {
    expect(ipBuckets("203.0.113.77")).toEqual({ ip: "203.0.113.77", network: "203.0.113.0/24" });
    expect(ipBuckets("::ffff:203.0.113.77")).toEqual({ ip: "203.0.113.77", network: "203.0.113.0/24" });
    expect(ipBuckets("2001:db8:1:2:3:4:5:6")).toEqual({ ip: "2001:0db8:0001:0002::/64", network: "2001:0db8:0001::/48" });
    expect(ipBuckets("2001:db8::1")).toEqual({ ip: "2001:0db8:0000:0000::/64", network: "2001:0db8:0000::/48" });
    expect(ipBuckets("::1").ip).toBe("0000:0000:0000:0000::/64");
  });
});

describe("staffed hours description", () => {
  test("human-readable windows", () => {
    expect(describeStaffedHours("20:00-24:00 Asia/Kolkata")).toBe("8 pm to midnight (Asia/Kolkata)");
    expect(describeStaffedHours("09:30-12:00 Europe/Berlin")).toBe("9:30 am to noon (Europe/Berlin)");
    expect(describeStaffedHours("00:00-01:15 America/New_York")).toBe("midnight to 1:15 am (America/New_York)");
    expect(describeStaffedHours("")).toBeNull();
    expect(describeStaffedHours("nonsense")).toBeNull();
  });
});

describe("turnstile", () => {
  const fake = (response: unknown, calls: { url: string; body: URLSearchParams }[] = []): FetchLike => {
    return async (url, init) => {
      calls.push({ url, body: init.body });
      if (response instanceof Error) throw response;
      return { ok: true, json: async () => response };
    };
  };

  test("passes the secret, token and IP to Siteverify", async () => {
    const calls: { url: string; body: URLSearchParams }[] = [];
    const res = await verifyTurnstile({ secret: "s3", token: "tok", remoteIp: "1.2.3.4", fetch: fake({ success: true }, calls) });
    expect(res.success).toBe(true);
    expect(calls[0]!.url).toBe(SITEVERIFY_URL);
    expect(calls[0]!.body.get("secret")).toBe("s3");
    expect(calls[0]!.body.get("response")).toBe("tok");
    expect(calls[0]!.body.get("remoteip")).toBe("1.2.3.4");
  });

  test("fails closed", async () => {
    const calls: { url: string; body: URLSearchParams }[] = [];
    expect((await verifyTurnstile({ secret: "s", token: undefined, fetch: fake({ success: true }, calls) })).success).toBe(false);
    expect(calls).toHaveLength(0);
    const failed = await verifyTurnstile({ secret: "s", token: "t", fetch: fake({ success: false, "error-codes": ["invalid-input-response"] }) });
    expect(failed).toEqual({ success: false, errors: ["invalid-input-response"] });
    expect((await verifyTurnstile({ secret: "s", token: "t", fetch: fake(new Error("down")) })).errors).toEqual(["network-error"]);
    expect((await verifyTurnstile({ secret: "s", token: "t", fetch: fake("nope") })).success).toBe(false);
    expect((await verifyTurnstile({ secret: "s", token: "t", fetch: fake({ success: "true" }) })).success).toBe(false);
    const notOk: FetchLike = async () => ({ ok: false, json: async () => ({ success: true }) });
    expect((await verifyTurnstile({ secret: "s", token: "t", fetch: notOk })).success).toBe(false);
  });
});

/** Shared behaviour of both KV implementations and everything built on them. */
function kvSuite(name: string, make: (clock: () => number) => SessionKv | null, controllableClock: boolean) {
  describe.skipIf(make(() => 0) === null)(name, () => {
    test("incr counts and expires; set/get/mget", async () => {
      let now = NOW;
      const kv = make(() => now)!;
      const key = `k:${randomUUID()}`;
      expect(await kv.incr(key, 60_000)).toBe(1);
      expect(await kv.incr(key, 60_000)).toBe(2);
      await kv.set(`${key}:v`, "x", 60_000);
      expect(await kv.get(`${key}:v`)).toBe("x");
      expect(await kv.mget([`${key}:v`, `${key}:missing`])).toEqual(["x", null]);
      if (controllableClock) {
        now += 60_001;
        expect(await kv.get(`${key}:v`)).toBeNull();
        expect(await kv.incr(key, 60_000)).toBe(1);
      }
    });

    test("lockout stores salted hashes only, survives rotation, and keeps strangers out of it", async () => {
      const kv = make(() => NOW)!;
      const salt = deriveSalt(SECRET, "lockout");
      const lockout = new Lockout(kv, [salt], () => NOW);
      const device = randomUUID();
      const fp = "f".repeat(64);
      expect(await lockout.isLocked(device, fp, "203.0.113.5")).toBe(false);
      await lockout.lock(device, fp, "203.0.113.5");
      expect(await lockout.isLocked(device, fp, "203.0.113.5")).toBe(true);
      // Same device anywhere; same fingerprint on the same /24 with a new device id.
      expect(await lockout.isLocked(device, "0".repeat(64), "198.51.100.1")).toBe(true);
      expect(await lockout.isLocked(randomUUID(), fp, "203.0.113.200")).toBe(true);
      // Same coarse fingerprint on another network is a stranger.
      expect(await lockout.isLocked(randomUUID(), fp, "198.51.100.1")).toBe(false);
      // After a secret rotation the old salt is still checked.
      const rotated = new Lockout(kv, [deriveSalt(OLD_SECRET, "lockout"), salt], () => NOW);
      expect(await rotated.isLocked(device, fp, "203.0.113.5")).toBe(true);
    });

    test("session rate limit per IP and per /24", async () => {
      let now = NOW;
      const kv = make(() => now)!;
      const limiter = new SessionRateLimiter(kv, deriveSalt(randomUUID(), "x"), { perIpPerMinute: 2, perNetworkPerMinute: 3 }, () => now);
      expect(await limiter.allow("192.0.2.1")).toBe(true);
      expect(await limiter.allow("192.0.2.1")).toBe(true);
      expect(await limiter.allow("192.0.2.1")).toBe(false);
      expect(await limiter.allow("192.0.2.2")).toBe(false); // the /24 is now at 4 > 3
      expect(await limiter.allow("198.51.100.9")).toBe(true);
      now += 60_000;
      expect(await limiter.allow("192.0.2.1")).toBe(true);
    });

    test("hourly match caps per device and per IP", async () => {
      let now = NOW;
      const kv = make(() => now)!;
      const caps = new MatchCaps(kv, deriveSalt(randomUUID(), "x"), { perDevicePerHour: 2, perIpPerHour: 3 }, () => now);
      const [a, b] = [randomUUID(), randomUUID()];
      await caps.bindIp(a, "192.0.2.1");
      await caps.bindIp(b, "192.0.2.1");
      await caps.recordMatch(a);
      expect(await caps.overCap(a)).toBe(false);
      await caps.recordMatch(a);
      expect(await caps.overCap(a)).toBe(true); // device cap
      expect(await caps.overCap(b)).toBe(false);
      await caps.recordMatch(b);
      expect(await caps.overCap(b)).toBe(true); // shared IP cap
      // An unbound device is capped per device only.
      const c = randomUUID();
      await caps.recordMatch(c);
      expect(await caps.overCap(c)).toBe(false);
      now += 60 * 60_000;
      expect(await caps.overCap(a)).toBe(false);
    });
  });
}

kvSuite("MemoryKv", (clock) => new MemoryKv(clock), true);

const redisUrl = process.env.REDIS_URL;
let redis: Redis | null = null;
kvSuite(
  "RedisKv",
  () => {
    if (!redisUrl) return null;
    redis ??= new Redis(redisUrl, { lazyConnect: false });
    return new RedisKv(redis, `chizzy:test:${randomUUID()}:`);
  },
  false,
);
afterAll(async () => {
  await redis?.quit();
});

describe.skipIf(!redisUrl)("RedisKv expiry", () => {
  test("incr sets a TTL once; set uses PX", async () => {
    const client = new Redis(redisUrl!);
    const prefix = `chizzy:test:${randomUUID()}:`;
    try {
      const kv = new RedisKv(client, prefix);
      await kv.incr("n", 5_000);
      const ttl1 = await client.pttl(`${prefix}n`);
      await kv.incr("n", 60_000);
      const ttl2 = await client.pttl(`${prefix}n`);
      expect(ttl1).toBeGreaterThan(0);
      expect(ttl2).toBeLessThanOrEqual(5_000);
      await kv.set("lock", "2026-10-04", DEVICE_LOCKOUT_MS);
      expect(await client.pttl(`${prefix}lock`)).toBeGreaterThan(FINGERPRINT_LOCKOUT_MS);
    } finally {
      const keys = await client.keys(`${prefix}*`);
      if (keys.length) await client.del(...keys);
      await client.quit();
    }
  });
});
