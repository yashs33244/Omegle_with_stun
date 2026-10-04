import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../../src/config";

describe("loadConfig", () => {
  test("defaults outside production", () => {
    const c = loadConfig({});
    expect(c.nodeEnv).toBe("development");
    expect(c.port).toBe(3004);
    expect(c.corsOrigins).toBe("*");
    expect(c.trustProxy).toBe(false);
    expect(c.maxConnectionsPerIp).toBe(10);
    expect(c.matchAcceptTimeoutMs).toBe(30000);
    expect(c.stunUrls).toEqual(["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]);
    expect(c.turnUrls).toEqual([]);
    expect(c.shutdownGraceMs).toBe(10000);
  });

  test("production without CORS_ORIGINS fails", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/CORS_ORIGINS/);
  });

  test("production rejects *", () => {
    expect(() => loadConfig({ NODE_ENV: "production", CORS_ORIGINS: "https://a.com,*" })).toThrow(/must not contain \*/);
  });

  test("production with an allowlist", () => {
    const c = loadConfig({ NODE_ENV: "production", CORS_ORIGINS: "https://a.com, https://b.com:8443" });
    expect(c.corsOrigins).toEqual(["https://a.com", "https://b.com:8443"]);
  });

  test("rejects malformed origins and numbers", () => {
    expect(() => loadConfig({ CORS_ORIGINS: "a.com" })).toThrow(/invalid origin/);
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ TRUST_PROXY: "maybe" })).toThrow(/TRUST_PROXY/);
  });

  test("empty values mean unset", () => {
    expect(loadConfig({ PORT: "", REDIS_URL: "" }).port).toBe(3004);
  });

  test(".env.example documents every variable and parses", async () => {
    const text = await Bun.file(`${__dirname}/../../.env.example`).text();
    const env: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (m) env[m[1]!] = m[2]!;
    }
    expect(Object.keys(env).sort()).toEqual(
      [
        "NODE_ENV", "PORT", "CORS_ORIGINS", "REDIS_URL", "TRUST_PROXY", "MAX_CONNECTIONS_PER_IP",
        "MATCH_ACCEPT_TIMEOUT_MS", "STUN_URLS", "TURN_URLS", "TURN_SECRET", "TURN_USERNAME",
        "TURN_CREDENTIAL", "TURN_TTL_SECONDS", "LOG_LEVEL", "METRICS_TOKEN", "SHUTDOWN_GRACE_MS",
        "TURN_PROVIDER", "CF_TURN_KEY_ID", "CF_TURN_API_TOKEN", "TURN_CACHE_SECONDS", "TURN_MAX_PER_DEVICE_HOUR",
        "TURN_MAX_PER_IP_HOUR", "CF_ACCOUNT_ID", "CF_ANALYTICS_TOKEN", "TURN_SPEND_DAILY_GB",
      ].sort(),
    );
    expect(() => loadConfig(env)).not.toThrow();
  });

  test("TURN secret needs TURN_URLS; static credentials come in pairs", () => {
    expect(() => loadConfig({ TURN_SECRET: "x" })).toThrow(/TURN_URLS/);
    expect(() => loadConfig({ TURN_URLS: "turn:t:3478", TURN_USERNAME: "u" })).toThrow(/TURN_CREDENTIAL/);
    const c = loadConfig({ TURN_URLS: "turn:t:3478,turns:t:5349", TURN_SECRET: "x", TRUST_PROXY: "true" });
    expect(c.turnUrls).toEqual(["turn:t:3478", "turns:t:5349"]);
    expect(c.trustProxy).toBe(true);
    expect(c.turnProvider).toBe("secret");
  });

  test("TURN provider and spend poller settings", () => {
    expect(loadConfig({}).turnProvider).toBe("none");
    expect(loadConfig({}).turnTtlSeconds).toBe(7200);
    expect(loadConfig({ TURN_URLS: "turn:t:3478", TURN_USERNAME: "u", TURN_CREDENTIAL: "p" }).turnProvider).toBe("static");
    expect(() => loadConfig({ TURN_PROVIDER: "cloudflare" })).toThrow(/CF_TURN_KEY_ID/);
    const cf = loadConfig({ TURN_PROVIDER: "cloudflare", CF_TURN_KEY_ID: "k", CF_TURN_API_TOKEN: "t" });
    expect(cf).toMatchObject({ turnProvider: "cloudflare", cfTurnKeyId: "k", cfTurnApiToken: "t", turnTtlSeconds: 7200 });
    expect(() => loadConfig({ TURN_PROVIDER: "secret" })).toThrow(/TURN_SECRET/);
    expect(() => loadConfig({ CF_ACCOUNT_ID: "a" })).toThrow(/CF_ANALYTICS_TOKEN/);
    expect(() => loadConfig({ TURN_SPEND_DAILY_GB: "50,40,60" })).toThrow(/TURN_SPEND_DAILY_GB/);
    expect(() => loadConfig({ TURN_SPEND_DAILY_GB: "1,2" })).toThrow(/TURN_SPEND_DAILY_GB/);
    expect(loadConfig({ TURN_SPEND_DAILY_GB: "10, 20,30" }).turnSpendDailyGb).toEqual([10, 20, 30]);
  });
});
