/**
 * Synthetic canary: two headless clients go through the real session gate and
 * matching and must both reach call:start within CANARY_TIMEOUT_MS (30 s).
 * Run by .github/workflows/canary.yml every 15 minutes when the repository
 * variable CANARY_URL is set. Exit codes: 0 ok or skipped (matching closed by
 * staffed hours or the kill switch), 1 failed.
 *
 *   CANARY_URL=https://staging-api.example.com node scripts/loadtest/canary.ts
 *
 * The two clients speak the "zxx" language code ("no linguistic content")
 * and filter on it, so the server's hard language filter only ever pairs them
 * with each other, never with a real person. They send no media.
 *
 * Turnstile: the session request carries CANARY_TURNSTILE_BYPASS when set,
 * otherwise Cloudflare's dummy test token, which only a backend running with a
 * Turnstile TEST secret accepts (a staging stack). See DEPLOYMENT.md.
 */
import { Stats, VirtualUser, fetchConfig, type UserOptions } from "./lib.ts";

const url = process.env.CANARY_URL;
if (!url) {
  console.error("CANARY_URL is not set");
  process.exit(1);
}
const timeoutMs = Number(process.env.CANARY_TIMEOUT_MS ?? 30_000);

const config = await fetchConfig(url);
if (!config) fail("GET /api/config failed or the API is unreachable");
if (!config.matchingOpen) {
  const reopens = config.reopensAt ? new Date(config.reopensAt).toISOString() : "unknown";
  console.log(`skipped: matching is closed (staffed hours or kill switch), reopens ${reopens}`);
  process.exit(0);
}

const opts: UserOptions = {
  url,
  session: true,
  tosVersion: config.tosVersion,
  turnstileToken: process.env.CANARY_TURNSTILE_BYPASS || "XXXX.DUMMY.TOKEN.XXXX",
  mode: config.defaultMode,
  language: "zxx",
  languageFilter: "zxx",
  topics: ["general"],
  signalRoundTrips: 1,
  holdMs: 1_000,
  maxCalls: 1,
  connectTimeoutMs: 15_000,
  instantFallbackMs: 2_000,
};

const stats = new Stats();
const started = new Set<number>();
const users: VirtualUser[] = [];
const t0 = Date.now();

const done = new Promise<"ok" | string>((resolve) => {
  const events = {
    onCallStart: (u: VirtualUser) => {
      started.add(u.index);
      if (started.size === 2) resolve("ok");
    },
    onFatal: (_u: VirtualUser, code: string) => resolve(code),
  };
  const a = new VirtualUser(0, opts, stats, events);
  const b = new VirtualUser(1, opts, stats, events);
  users.push(a, b);
  void a.start();
  void b.start();
  setTimeout(() => resolve(`timeout: call:start not reached by both clients within ${timeoutMs} ms`), timeoutMs);
});

const result = await done;
for (const u of users) u.stop();
const elapsed = Date.now() - t0;

if (result === "ok") {
  const lat = Object.fromEntries(stats.latencies().map((l) => [l.name, l.max]));
  console.log(`ok: both clients reached call:start in ${elapsed} ms`, JSON.stringify(lat));
  process.exit(0);
}
if (result === "session:closed") {
  console.log("skipped: new sessions are disabled by the kill switch");
  process.exit(0);
}
fail(`${result} (after ${elapsed} ms; errors ${JSON.stringify(Object.fromEntries(stats.errors))})`);

function fail(message: string): never {
  console.error(`canary FAILED: ${message}`);
  process.exit(1);
}
