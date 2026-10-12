import { describe, expect, test } from "bun:test";
import { Registry } from "prom-client";
import { FlagsReader, MemoryFlagsStore } from "../../src/flags/flags";
import { createLogger } from "../../src/logger";
import { createMatchMetrics } from "../../src/match/matchMetrics";
import { cloudflareTurnUrl, dropPort53, fetchCloudflareIceServers, isPort53 } from "../../src/turn/cloudflare";
import { DEVICE_IP_TTL_MS } from "../../src/turn/constants";
import { MemoryTurnStore } from "../../src/turn/store";
import { TurnService, ipKey } from "../../src/turn/TurnService";
import { fakeCloudflare } from "../fixtures/cloudflare";
import { testConfig } from "../helpers";

function service(overrides: Parameters<typeof testConfig>[0] = {}, fetch = fakeCloudflare().fetch, now: () => number = Date.now) {
  const flags = new FlagsReader(new MemoryFlagsStore());
  const metrics = createMatchMetrics(new Registry());
  const config = testConfig({
    turnProvider: "cloudflare",
    cfTurnKeyId: "key-1",
    cfTurnApiToken: "token-1",
    stunUrls: ["stun:stun.example.com:3478"],
    ...overrides,
  });
  const turn = new TurnService({ config, flags, store: new MemoryTurnStore(now), logger: createLogger("silent"), metrics, fetch, now });
  return { turn, flags, metrics };
}

/** A socket address key, as MatchService stores it on the session at hello. */
const SOCKET_KEY = "socket-ip-key";
const STUN_ONLY = [{ urls: ["stun:stun.example.com:3478"] }];

describe("cloudflare helpers", () => {
  test("port 53 detection", () => {
    expect(isPort53("turn:turn.cloudflare.com:53?transport=udp")).toBe(true);
    expect(isPort53("stun:stun.cloudflare.com:53")).toBe(true);
    expect(isPort53("turns:turn.cloudflare.com:5349?transport=tcp")).toBe(false);
    expect(isPort53("turn:host53.example.com:3478")).toBe(false);
  });

  test("dropPort53 keeps turns:443 and removes empty entries", () => {
    const out = dropPort53([{ urls: "stun:x:53" }, { urls: ["turn:x:53", "turns:x:443?transport=tcp"], username: "u", credential: "c" }]);
    expect(out).toEqual([{ urls: ["turns:x:443?transport=tcp"], username: "u", credential: "c" }]);
  });

  test("fetchCloudflareIceServers posts ttl with the bearer token", async () => {
    const cf = fakeCloudflare();
    const servers = await fetchCloudflareIceServers({ keyId: "key-1", apiToken: "token-1", ttlSeconds: 7200, fetch: cf.fetch });
    expect(cf.calls[0]!.url).toBe(cloudflareTurnUrl("key-1"));
    expect(cf.calls[0]!.url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key-1/credentials/generate-ice-servers");
    expect(cf.calls[0]!.init?.method).toBe("POST");
    expect((cf.calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
    expect(JSON.parse(String(cf.calls[0]!.init?.body))).toEqual({ ttl: 7200 });
    const all = servers.flatMap((s) => s.urls);
    expect(all.some(isPort53)).toBe(false);
    expect(all).toContain("turns:turn.cloudflare.com:5349?transport=tcp");
    expect(all).toContain("turns:turn.cloudflare.com:443?transport=tcp");
    expect(servers.find((s) => s.username)).toMatchObject({ username: "cf-user", credential: "cf-pass" });
  });

  test("errors and credential-less answers throw", async () => {
    await expect(
      fetchCloudflareIceServers({ keyId: "k", apiToken: "t", ttlSeconds: 1, fetch: fakeCloudflare({ status: 401 }).fetch }),
    ).rejects.toThrow(/401/);
    await expect(
      fetchCloudflareIceServers({ keyId: "k", apiToken: "t", ttlSeconds: 1, fetch: fakeCloudflare({ body: { iceServers: [{ urls: "stun:x" }] } }).fetch }),
    ).rejects.toThrow(/no TURN/);
  });
});

test("ipKey is a keyed hash: no raw IP, different per secret", () => {
  const k = ipKey("203.0.113.9", "s1");
  expect(k).toMatch(/^[a-f0-9]{32}$/);
  expect(k).toBe(ipKey("203.0.113.9", "s1"));
  expect(k).not.toBe(ipKey("203.0.113.9", "s2"));
  expect(k).not.toBe(ipKey("203.0.113.10", "s1"));
});

describe("TurnService", () => {
  test("STUN for hello; STUN + TURN per call with the flag caps", async () => {
    const { turn } = service();
    expect(turn.stunServers()).toEqual([{ urls: ["stun:stun.example.com:3478"] }]);
    const media = await turn.callMedia("dev-1", SOCKET_KEY);
    expect(media.iceServers[0]).toEqual({ urls: ["stun:stun.example.com:3478"] });
    expect(media.iceServers.some((s) => s.username === "cf-user")).toBe(true);
    expect(media).toMatchObject({ maxBitrateKbps: 900, relayMaxBitrateKbps: 500, privateModeAllowed: true });
  });

  test("one credential set per device is cached", async () => {
    const cf = fakeCloudflare();
    const { turn, metrics } = service({}, cf.fetch);
    await turn.callMedia("dev-1", SOCKET_KEY);
    await turn.callMedia("dev-1", SOCKET_KEY);
    await Promise.all([turn.callMedia("dev-2", SOCKET_KEY), turn.callMedia("dev-2", SOCKET_KEY)]);
    expect(cf.calls.length).toBe(2);
    expect((await metrics.turnCredentialsTotal.get()).values.find((v) => v.labels.result === "cached")?.value).toBeGreaterThan(0);
  });

  test("per-device and per-IP hourly caps fall back to STUN only", async () => {
    const { turn } = service({ turnCacheSeconds: 0, turnMaxPerDeviceHour: 2, turnMaxPerIpHour: 3 });
    expect((await turn.callMedia("dev-1", SOCKET_KEY)).privateModeAllowed).toBe(true);
    expect((await turn.callMedia("dev-1", SOCKET_KEY)).privateModeAllowed).toBe(true);
    const capped = await turn.callMedia("dev-1", SOCKET_KEY);
    expect(capped.iceServers).toEqual(STUN_ONLY);
    expect(capped.privateModeAllowed).toBe(false);

    // The hello binding counts, whatever key each socket carries.
    for (const d of ["a", "b", "c", "d"]) await turn.rememberIp(d, "203.0.113.9");
    expect((await turn.callMedia("a", "ka")).privateModeAllowed).toBe(true);
    expect((await turn.callMedia("b", "kb")).privateModeAllowed).toBe(true);
    expect((await turn.callMedia("c", "kc")).privateModeAllowed).toBe(true);
    expect((await turn.callMedia("d", "kd")).privateModeAllowed).toBe(false); // 4th set from one IP
  });

  test("IPv6 addresses in one /64 share the per-IP cap", async () => {
    const { turn } = service({ turnCacheSeconds: 0, turnMaxPerIpHour: 2 });
    expect(turn.ipKeyFor("2001:db8:1:2::a")).toBe(turn.ipKeyFor("2001:db8:1:2:ffff::b"));
    expect(turn.ipKeyFor("2001:db8:1:2::a")).not.toBe(turn.ipKeyFor("2001:db8:1:3::a"));
    expect(turn.ipKeyFor("::ffff:203.0.113.9")).toBe(turn.ipKeyFor("203.0.113.9"));
    for (const [i, d] of ["a", "b", "c"].entries()) await turn.rememberIp(d, `2001:db8:1:2::${i + 1}`);
    expect((await turn.callMedia("a", null)).privateModeAllowed).toBe(true);
    expect((await turn.callMedia("b", null)).privateModeAllowed).toBe(true);
    expect((await turn.callMedia("c", null)).privateModeAllowed).toBe(false);
  });

  test("without a hello binding the socket's address counts; without either, no relay", async () => {
    let now = 1_000_000;
    const { turn, metrics } = service({ turnCacheSeconds: 0, turnMaxPerDeviceHour: 100, turnMaxPerIpHour: 2 }, undefined, () => now);
    const results = async () =>
      Object.fromEntries((await metrics.turnCredentialsTotal.get()).values.map((v) => [v.labels.result, v.value]));

    // No binding and no socket address: STUN only, nothing counted.
    const refused = await turn.callMedia("fresh", null);
    expect(refused).toMatchObject({ iceServers: STUN_ONLY, privateModeAllowed: false });
    expect(await results()).toEqual({ no_ip: 1 });

    // The binding from hello lapses after a day; the socket's key then counts.
    await turn.rememberIp("old", "203.0.113.9");
    now += DEVICE_IP_TTL_MS + 1;
    const socketKey = turn.ipKeyFor("203.0.113.9");
    expect((await turn.callMedia("old", socketKey)).privateModeAllowed).toBe(true);
    expect((await turn.callMedia("other", socketKey)).privateModeAllowed).toBe(true);
    expect((await turn.callMedia("third", socketKey)).privateModeAllowed).toBe(false); // over 2 per IP
    expect((await turn.callMedia("old", null)).privateModeAllowed).toBe(false); // binding gone, no key
    expect(await results()).toEqual({ no_ip: 2, issued: 2, capped: 1 });
  });

  test("API failure and turn_enabled=false give STUN only; private mode needs both flags", async () => {
    const failing = service({}, fakeCloudflare({ status: 500 }).fetch);
    expect(await failing.turn.callMedia("dev-1", SOCKET_KEY)).toMatchObject({
      iceServers: [{ urls: ["stun:stun.example.com:3478"] }],
      privateModeAllowed: false,
    });

    const { turn, flags } = service();
    await flags.set({ turn_enabled: false, video_max_kbps: 700, relay_video_max_kbps: 300 });
    expect(await turn.callMedia("dev-2", SOCKET_KEY)).toEqual({
      iceServers: [{ urls: ["stun:stun.example.com:3478"] }],
      maxBitrateKbps: 700,
      relayMaxBitrateKbps: 300,
      privateModeAllowed: false,
    });
    await flags.set({ turn_enabled: true, private_mode_enabled: false });
    const media = await turn.callMedia("dev-3", SOCKET_KEY);
    expect(media.iceServers.length).toBeGreaterThan(1);
    expect(media.privateModeAllowed).toBe(false);
  });

  test("secret and static providers keep working per call", async () => {
    const secret = service({ turnProvider: "secret", turnUrls: ["turn:t:3478"], turnSecret: "s3cret" });
    const s = await secret.turn.callMedia("6f1c1f2e-8a8b-4c39-9b0e-6d2a6f1b9c11", SOCKET_KEY);
    expect(s.iceServers[1]).toMatchObject({ urls: ["turn:t:3478"] });
    expect(s.iceServers[1]!.username).toMatch(/^\d+:6f1c1f2e-8a8b-4c39-9b0e-6d2a6f1b9c11$/);

    const fixed = service({ turnProvider: "static", turnUrls: ["turn:t:3478"], turnUsername: "u", turnCredential: "p" });
    expect((await fixed.turn.callMedia("d", SOCKET_KEY)).iceServers[1]).toEqual({ urls: ["turn:t:3478"], username: "u", credential: "p" });

    const none = service({ turnProvider: "none" });
    expect(await none.turn.callMedia("d", SOCKET_KEY)).toMatchObject({ privateModeAllowed: false, iceServers: [{ urls: ["stun:stun.example.com:3478"] }] });
  });
});
