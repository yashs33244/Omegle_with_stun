import { describe, expect, test } from "bun:test";
import { Registry } from "prom-client";
import { FlagsReader, MemoryFlagsStore } from "../../src/flags/flags";
import { createLogger } from "../../src/logger";
import { createMatchMetrics } from "../../src/match/matchMetrics";
import { cloudflareTurnUrl, dropPort53, fetchCloudflareIceServers, isPort53 } from "../../src/turn/cloudflare";
import { MemoryTurnStore } from "../../src/turn/store";
import { TurnService } from "../../src/turn/TurnService";
import { testConfig } from "../helpers";

/** What generate-ice-servers answers (shape from the Cloudflare docs). */
export const CF_RESPONSE = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "cf-user",
      credential: "cf-pass",
    },
  ],
};

interface FakeCall {
  url: string;
  init?: RequestInit;
}

export function fakeCloudflare(opts: { status?: number; body?: unknown } = {}) {
  const calls: FakeCall[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(opts.body ?? CF_RESPONSE), { status: opts.status ?? 200 });
  };
  return { fetch, calls };
}

function service(overrides: Parameters<typeof testConfig>[0] = {}, fetch = fakeCloudflare().fetch) {
  const flags = new FlagsReader(new MemoryFlagsStore());
  const metrics = createMatchMetrics(new Registry());
  const config = testConfig({
    turnProvider: "cloudflare",
    cfTurnKeyId: "key-1",
    cfTurnApiToken: "token-1",
    stunUrls: ["stun:stun.example.com:3478"],
    ...overrides,
  });
  const turn = new TurnService({ config, flags, store: new MemoryTurnStore(), logger: createLogger("silent"), metrics, fetch });
  return { turn, flags, metrics };
}

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

describe("TurnService", () => {
  test("STUN for hello; STUN + TURN per call with the flag caps", async () => {
    const { turn } = service();
    expect(turn.stunServers()).toEqual([{ urls: ["stun:stun.example.com:3478"] }]);
    const media = await turn.callMedia("dev-1");
    expect(media.iceServers[0]).toEqual({ urls: ["stun:stun.example.com:3478"] });
    expect(media.iceServers.some((s) => s.username === "cf-user")).toBe(true);
    expect(media).toMatchObject({ maxBitrateKbps: 900, relayMaxBitrateKbps: 500, privateModeAllowed: true });
  });

  test("one credential set per device is cached", async () => {
    const cf = fakeCloudflare();
    const { turn, metrics } = service({}, cf.fetch);
    await turn.callMedia("dev-1");
    await turn.callMedia("dev-1");
    await Promise.all([turn.callMedia("dev-2"), turn.callMedia("dev-2")]);
    expect(cf.calls.length).toBe(2);
    expect((await metrics.turnCredentialsTotal.get()).values.find((v) => v.labels.result === "cached")?.value).toBeGreaterThan(0);
  });

  test("per-device and per-IP hourly caps fall back to STUN only", async () => {
    const { turn } = service({ turnCacheSeconds: 0, turnMaxPerDeviceHour: 2, turnMaxPerIpHour: 3 });
    expect((await turn.callMedia("dev-1")).privateModeAllowed).toBe(true);
    expect((await turn.callMedia("dev-1")).privateModeAllowed).toBe(true);
    const capped = await turn.callMedia("dev-1");
    expect(capped.iceServers).toEqual([{ urls: ["stun:stun.example.com:3478"] }]);
    expect(capped.privateModeAllowed).toBe(false);

    for (const d of ["a", "b", "c", "d"]) await turn.rememberIp(d, "203.0.113.9");
    expect((await turn.callMedia("a")).privateModeAllowed).toBe(true);
    expect((await turn.callMedia("b")).privateModeAllowed).toBe(true);
    expect((await turn.callMedia("c")).privateModeAllowed).toBe(true);
    expect((await turn.callMedia("d")).privateModeAllowed).toBe(false); // 4th set from one IP
  });

  test("API failure and turn_enabled=false give STUN only; private mode needs both flags", async () => {
    const failing = service({}, fakeCloudflare({ status: 500 }).fetch);
    expect(await failing.turn.callMedia("dev-1")).toMatchObject({
      iceServers: [{ urls: ["stun:stun.example.com:3478"] }],
      privateModeAllowed: false,
    });

    const { turn, flags } = service();
    await flags.set({ turn_enabled: false, video_max_kbps: 700, relay_video_max_kbps: 300 });
    expect(await turn.callMedia("dev-2")).toEqual({
      iceServers: [{ urls: ["stun:stun.example.com:3478"] }],
      maxBitrateKbps: 700,
      relayMaxBitrateKbps: 300,
      privateModeAllowed: false,
    });
    await flags.set({ turn_enabled: true, private_mode_enabled: false });
    const media = await turn.callMedia("dev-3");
    expect(media.iceServers.length).toBeGreaterThan(1);
    expect(media.privateModeAllowed).toBe(false);
  });

  test("secret and static providers keep working per call", async () => {
    const secret = service({ turnProvider: "secret", turnUrls: ["turn:t:3478"], turnSecret: "s3cret" });
    const s = await secret.turn.callMedia("6f1c1f2e-8a8b-4c39-9b0e-6d2a6f1b9c11");
    expect(s.iceServers[1]).toMatchObject({ urls: ["turn:t:3478"] });
    expect(s.iceServers[1]!.username).toMatch(/^\d+:6f1c1f2e-8a8b-4c39-9b0e-6d2a6f1b9c11$/);

    const fixed = service({ turnProvider: "static", turnUrls: ["turn:t:3478"], turnUsername: "u", turnCredential: "p" });
    expect((await fixed.turn.callMedia("d")).iceServers[1]).toEqual({ urls: ["turn:t:3478"], username: "u", credential: "p" });

    const none = service({ turnProvider: "none" });
    expect(await none.turn.callMedia("d")).toMatchObject({ privateModeAllowed: false, iceServers: [{ urls: ["stun:stun.example.com:3478"] }] });
  });
});
