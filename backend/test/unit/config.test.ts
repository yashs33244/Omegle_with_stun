import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../../src/config";

const ADMIN = "a".repeat(32);

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

  const PROD = {
    NODE_ENV: "production",
    CORS_ORIGINS: "https://a.com",
    SESSION_SECRET: "s".repeat(32),
    TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    ADMIN_TOKEN: ADMIN,
  };

  test("production with an allowlist", () => {
    const c = loadConfig({ ...PROD, CORS_ORIGINS: "https://a.com, https://b.com:8443" });
    expect(c.corsOrigins).toEqual(["https://a.com", "https://b.com:8443"]);
    expect(c.requireSession).toBe(true);
    expect(c.sessionSecretGenerated).toBe(false);
  });

  test("production needs a long SESSION_SECRET and Turnstile (or an explicit opt-out)", () => {
    expect(() => loadConfig({ ...PROD, SESSION_SECRET: undefined })).toThrow(/SESSION_SECRET: is required/);
    expect(() => loadConfig({ ...PROD, SESSION_SECRET: "short" })).toThrow(/at least 32/);
    expect(() => loadConfig({ ...PROD, TURNSTILE_SECRET: undefined })).toThrow(/TURNSTILE_SECRET/);
    expect(() => loadConfig({ ...PROD, TURNSTILE_SITE_KEY: undefined })).toThrow(/TURNSTILE_SITE_KEY/);
    const off = loadConfig({ ...PROD, TURNSTILE_SECRET: undefined, TURNSTILE_DISABLED: "true" });
    expect(off.turnstileSecret).toBeUndefined();
  });

  test("outside production the session secret is generated and the gate stays on", () => {
    const a = loadConfig({});
    expect(a.sessionSecretGenerated).toBe(true);
    expect(a.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(loadConfig({}).sessionSecret).not.toBe(a.sessionSecret);
    expect(a.requireSession).toBe(true);
    expect(a.trustCloudflare).toBe(false);
    expect(a.matchCapPerDevicePerHour).toBe(200);
    expect(a.matchCapPerIpPerHour).toBe(200);
  });

  test("production requires a long ADMIN_TOKEN", () => {
    expect(() => loadConfig({ ...PROD, ADMIN_TOKEN: undefined })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ ...PROD, ADMIN_TOKEN: "short" })).toThrow(/ADMIN_TOKEN: must be at least 24 characters/);
    expect(loadConfig({}).adminToken).toBeUndefined();
  });

  test("enforcement settings", () => {
    const c = loadConfig({ ADMIN_ALLOWED_IPS: "203.0.113.1, 2001:db8::1", EVIDENCE_S3_BUCKET: "chizzy-evidence" });
    expect(c.adminAllowedIps).toEqual(["203.0.113.1", "2001:db8::1"]);
    expect(c.evidenceDir).toBe("./data/evidence");
    expect(c.evidenceS3Bucket).toBe("chizzy-evidence");
    expect(c.reportAfterEndMs).toBe(60_000);
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
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) env[m[1]!] = m[2]!;
    }
    expect(Object.keys(env).sort()).toEqual(
      [
        "NODE_ENV", "PORT", "CORS_ORIGINS", "REDIS_URL", "TRUST_PROXY", "MAX_CONNECTIONS_PER_IP",
        "MATCH_ACCEPT_TIMEOUT_MS", "STUN_URLS", "TURN_URLS", "TURN_SECRET", "TURN_USERNAME",
        "TURN_CREDENTIAL", "TURN_TTL_SECONDS", "LOG_LEVEL", "METRICS_TOKEN", "SHUTDOWN_GRACE_MS",
        "SESSION_SECRET", "SESSION_SECRET_PREVIOUS", "TURNSTILE_SECRET", "TURNSTILE_SITE_KEY",
        "TURNSTILE_DISABLED", "TRUST_CLOUDFLARE", "SESSION_RATE_PER_IP_PER_MIN",
        "SESSION_RATE_PER_NETWORK_PER_MIN", "MATCH_CAP_PER_DEVICE_PER_HOUR", "MATCH_CAP_PER_IP_PER_HOUR",
        "SENTRY_DSN", "SENTRY_DSN_FRONTEND", "POSTHOG_KEY", "POSTHOG_HOST",
        "TURN_PROVIDER", "CF_TURN_KEY_ID", "CF_TURN_API_TOKEN", "TURN_CACHE_SECONDS", "TURN_MAX_PER_DEVICE_HOUR",
        "TURN_MAX_PER_IP_HOUR", "CF_ACCOUNT_ID", "CF_ANALYTICS_TOKEN", "TURN_SPEND_DAILY_GB",
        "ADMIN_TOKEN", "ADMIN_ALLOWED_IPS", "EVIDENCE_DIR", "EVIDENCE_S3_BUCKET", "EVIDENCE_S3_REGION",
        "EVIDENCE_S3_KMS_KEY_ID", "PSEUDONYM_SALT", "TURNSTILE_SECRET_KEY",
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
