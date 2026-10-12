/**
 * Signaling load test: N virtual users through session, handshake, hello,
 * match, accept, rtc:signal ping-pong, chat and skip, with a ramp-up and a
 * latency summary. See docs/capacity.md for how to run it and past results.
 *
 *   cd backend && bun install          # provides socket.io-client
 *   node scripts/loadtest/loadtest.ts --url http://127.0.0.1:3004 --users 200
 *
 * The target needs: TURNSTILE_DISABLED=true (or test keys), a high
 * MAX_CONNECTIONS_PER_IP and MAX_CONNECTIONS_PER_NETWORK, raised connect rates
 * and relaxed per-IP session limits, because every virtual user comes from
 * this one machine. Never point it at production.
 */
import { writeFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import type { MatchMode, Topic } from "../../backend/src/protocol.ts";
import { Stats, VirtualUser, fetchConfig, type UserOptions } from "./lib.ts";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:3004" },
    users: { type: "string", default: "200" },
    ramp: { type: "string", default: "20" },
    duration: { type: "string", default: "60" },
    calls: { type: "string", default: "0" },
    hold: { type: "string", default: "5000" },
    signals: { type: "string", default: "10" },
    mode: { type: "string", default: "instant" },
    "skip-session": { type: "boolean", default: false },
    "turnstile-token": { type: "string" },
    "tos-version": { type: "string" },
    json: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`Usage: node scripts/loadtest/loadtest.ts [options]
  --url URL              API origin (default http://127.0.0.1:3004)
  --users N              virtual users (default 200)
  --ramp S               seconds to start all users (default 20)
  --duration S           seconds to keep running after the ramp (default 60)
  --calls N              stop each user after N calls (default 0 = until the end)
  --hold MS              time in each call before the initiator presses Next (default 5000)
  --signals N            candidate ping-pong round trips per call (default 10)
  --mode instant|preview match mode sent in hello (default instant)
  --skip-session         connect without POST /api/session (backend without the session gate)
  --turnstile-token T    token for the session request (default: the Turnstile test dummy token)
  --tos-version V        ToS version to accept (default: from GET /api/config)
  --json FILE            also write the summary as JSON`);
  process.exit(0);
}

const users = Number(args.users);
const rampMs = Number(args.ramp) * 1000;
const durationMs = Number(args.duration) * 1000;
const mode = args.mode as MatchMode;
if (mode !== "instant" && mode !== "preview") throw new Error("--mode must be instant or preview");

const url = args.url ?? "http://127.0.0.1:3004";
const config = args["skip-session"] ? null : await fetchConfig(url);
if (!args["skip-session"] && !config && !args["tos-version"]) {
  console.error("GET /api/config failed. Pass --tos-version, or --skip-session for a backend without the session gate.");
  process.exit(2);
}

const opts: UserOptions = {
  url,
  session: !args["skip-session"],
  tosVersion: args["tos-version"] ?? config?.tosVersion ?? "",
  // Cloudflare's test secret keys accept this dummy token; a real secret rejects it.
  turnstileToken: args["turnstile-token"] ?? "XXXX.DUMMY.TOKEN.XXXX",
  mode,
  language: "en",
  languageFilter: "any",
  topics: ["general"] as Topic[],
  signalRoundTrips: Number(args.signals),
  holdMs: Number(args.hold),
  maxCalls: Number(args.calls),
  connectTimeoutMs: 20_000,
  instantFallbackMs: 1_500,
};

const stats = new Stats();
const all: VirtualUser[] = [];
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

let peakConnected = 0;
const sampler = setInterval(() => {
  const now = all.filter((u) => u.connected).length;
  peakConnected = Math.max(peakConnected, now);
}, 250);

const started = Date.now();
console.log(
  `load test: ${users} users over ${rampMs / 1000}s, then ${durationMs / 1000}s steady, mode ${mode}, ` +
    `session ${opts.session ? "on" : "SKIPPED"}, target ${opts.url}`,
);

const progress = setInterval(() => {
  const connected = all.filter((u) => u.connected).length;
  console.log(
    `  t=${Math.round((Date.now() - started) / 1000)}s connected=${connected} matches=${stats.count("matches") / 2} ` +
      `calls=${stats.count("call_starts") / 2} errors=${stats.totalErrors()}`,
  );
}, 5_000);

for (let i = 0; i < users; i++) {
  const user = new VirtualUser(i, opts, stats);
  all.push(user);
  void user.start();
  if (rampMs > 0 && i < users - 1) await sleep(rampMs / users);
}
await sleep(durationMs);

clearInterval(progress);
clearInterval(sampler);
for (const u of all) u.stop();
loop.disable();
await sleep(500);

const elapsedS = (Date.now() - started) / 1000;
const summary = {
  target: opts.url,
  users,
  rampSeconds: rampMs / 1000,
  steadySeconds: durationMs / 1000,
  elapsedSeconds: Math.round(elapsedS),
  mode,
  session: opts.session,
  peakConnected,
  matches: stats.count("matches") / 2,
  callStarts: stats.count("call_starts") / 2,
  callsCompleted: stats.count("calls_completed_sides") / 2,
  callsPerSecond: Math.round((stats.count("call_starts") / 2 / elapsedS) * 10) / 10,
  instantFallbackAccepts: stats.count("instant_fallback_accepts"),
  chatReceived: stats.count("chat_received"),
  latenciesMs: stats.latencies(),
  counters: Object.fromEntries(stats.counters),
  errors: Object.fromEntries(stats.errors),
  generatorEventLoopP99Ms: Math.round(loop.percentile(99) / 1e4) / 100,
};

console.log("\nSummary");
console.log(`  peak connected sockets  ${summary.peakConnected}`);
console.log(`  matches / call starts   ${summary.matches} / ${summary.callStarts} (${summary.callsPerSecond} calls/s)`);
console.log(`  calls completed         ${summary.callsCompleted}`);
if (summary.instantFallbackAccepts > 0) {
  console.log(`  instant fallback accepts ${summary.instantFallbackAccepts} (the server did not auto-accept instant matches)`);
}
console.log("  latency (ms)               n      p50      p95      p99      max");
for (const l of summary.latenciesMs) {
  console.log(
    `    ${l.name.padEnd(22)} ${String(l.n).padStart(6)} ${fmt(l.p50)} ${fmt(l.p95)} ${fmt(l.p99)} ${fmt(l.max)}`,
  );
}
console.log(`  errors                  ${Object.keys(summary.errors).length === 0 ? "none" : JSON.stringify(summary.errors)}`);
console.log(`  generator loop lag p99  ${summary.generatorEventLoopP99Ms} ms (high values mean the load generator, not the server, is the bottleneck)`);
if (args.json) writeFileSync(args.json, `${JSON.stringify(summary, null, 2)}\n`);

process.exit(stats.totalErrors() > 0 ? 1 : 0);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmt(n: number): string {
  return n.toFixed(1).padStart(8);
}
