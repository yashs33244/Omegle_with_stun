import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../../src/config";
import { originAllowed } from "../../src/realtime/socket";

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
      ].sort(),
    );
    expect(() => loadConfig(env)).not.toThrow();
    // The example says to copy it for local use, and the frontend dev server
    // (`npm run dev` in new-frontend) runs on http://localhost:8080.
    const { corsOrigins } = loadConfig(env);
    expect(originAllowed("http://localhost:8080", corsOrigins)).toBe(true);
    expect(originAllowed("http://localhost:5173", corsOrigins)).toBe(true);
  });

  test("TURN secret needs TURN_URLS; static credentials come in pairs", () => {
    expect(() => loadConfig({ TURN_SECRET: "x" })).toThrow(/TURN_URLS/);
    expect(() => loadConfig({ TURN_URLS: "turn:t:3478", TURN_USERNAME: "u" })).toThrow(/TURN_CREDENTIAL/);
    const c = loadConfig({ TURN_URLS: "turn:t:3478,turns:t:5349", TURN_SECRET: "x", TRUST_PROXY: "true" });
    expect(c.turnUrls).toEqual(["turn:t:3478", "turns:t:5349"]);
    expect(c.trustProxy).toBe(true);
  });

  test("STUN and TURN URLs must use their scheme", () => {
    const turn = (TURN_URLS: string) => loadConfig({ TURN_URLS, TURN_SECRET: "x" });
    expect(() => turn("turn.example.com:3478")).toThrow(/TURN_URLS: invalid URL "turn.example.com:3478"/);
    expect(() => turn("turn:a:3478 turn:b:3478")).toThrow(/TURN_URLS: invalid URL/);
    expect(() => turn("stun:stun.example.com:3478")).toThrow(/TURN_URLS: invalid URL/);
    expect(() => loadConfig({ STUN_URLS: "stun.example.com:19302" })).toThrow(/STUN_URLS: invalid URL/);
    expect(() => loadConfig({ STUN_URLS: "turn:t:3478" })).toThrow(/STUN_URLS: invalid URL/);
    expect(turn("turn:t:3478?transport=udp, turns:t:5349").turnUrls).toEqual(["turn:t:3478?transport=udp", "turns:t:5349"]);
    expect(loadConfig({ STUN_URLS: "stun:s:3478,stuns:s:5349" }).stunUrls).toEqual(["stun:s:3478", "stuns:s:5349"]);
  });
});
