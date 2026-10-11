import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { Registry } from "prom-client";
import { FlagsReader, MemoryFlagsStore } from "../../src/flags/flags";
import { createLogger } from "../../src/logger";
import { createMatchMetrics } from "../../src/match/matchMetrics";
import { CLOUDFLARE_GRAPHQL_URL } from "../../src/turn/constants";
import { TurnSpendPoller, cloudflareEgressQuery, parseEgressResponse, type EgressQuery } from "../../src/turn/spendPoller";

const GB = 1e9;
/** A Cloudflare GraphQL answer: one group per minute bucket. */
const FIXTURE = {
  data: {
    viewer: {
      accounts: [
        {
          callsTurnUsageAdaptiveGroups: [
            { sum: { egressBytes: 20 * GB } },
            { sum: { egressBytes: 16.5 * GB } },
          ],
        },
      ],
    },
  },
  errors: null,
};

function poller(gbSeq: number[], extra: { redis?: Redis; lockKey?: string } = {}) {
  const flags = new FlagsReader(new MemoryFlagsStore());
  const metrics = createMatchMetrics(new Registry());
  const errors: unknown[] = [];
  const logger = createLogger("silent");
  logger.error = ((obj: unknown) => errors.push(obj)) as typeof logger.error;
  let i = 0;
  const query: EgressQuery = async () => {
    const gb = gbSeq[Math.min(i++, gbSeq.length - 1)]!;
    if (Number.isNaN(gb)) throw new Error("analytics down");
    return gb * GB;
  };
  const p = new TurnSpendPoller({ flags, query, thresholdsGb: [35, 50, 70], intervalMs: 60_000, logger, metrics, ...extra });
  return { p, flags, metrics, errors };
}

const stepCount = async (metrics: ReturnType<typeof createMatchMetrics>, step: string) =>
  (await metrics.turnSpendStepsTotal.get()).values.find((v) => v.labels.step === step)?.value ?? 0;

describe("parseEgressResponse", () => {
  test("sums egress bytes across groups", () => {
    expect(parseEgressResponse(FIXTURE)).toBe(36.5 * GB);
  });

  test("an account with no traffic yet is zero", () => {
    expect(parseEgressResponse({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [] }] } } })).toBe(0);
  });

  test("GraphQL errors and unexpected shapes throw", () => {
    expect(() => parseEgressResponse({ data: null, errors: [{ message: "not authorized" }] })).toThrow(/not authorized/);
    expect(() => parseEgressResponse({ data: { viewer: { accounts: [] } } })).toThrow(/no account/);
    expect(() =>
      parseEgressResponse({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: "x" } }] }] } } }),
    ).toThrow(/egressBytes/);
  });
});

test("cloudflareEgressQuery posts the query for today's window with the analytics token", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const query = cloudflareEgressQuery({
    accountId: "acc-1",
    apiToken: "tok-1",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(FIXTURE));
    },
  });
  const start = new Date("2026-10-04T00:00:00Z");
  const end = new Date("2026-10-04T10:15:00Z");
  expect(await query(start, end)).toBe(36.5 * GB);
  expect(calls[0]!.url).toBe(CLOUDFLARE_GRAPHQL_URL);
  expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect(body.variables).toEqual({ accountTag: "acc-1", start: start.toISOString(), end: end.toISOString() });
  expect(body.query).toContain("egressBytes");
});

describe("TurnSpendPoller", () => {
  test("below the first threshold nothing changes", async () => {
    const { p, flags, metrics } = poller([10]);
    expect(await p.poll()).toEqual({ status: "ok", gb: 10, applied: [] });
    expect(flags.current()).toMatchObject({ relay_video_max_kbps: 500, private_mode_enabled: true, turn_enabled: true });
    expect(await metrics.turnEgressGbToday.get()).toMatchObject({ values: [{ value: 10 }] });
  });

  test("steps down one threshold at a time, once each, with an error log and a metric", async () => {
    const { p, flags, metrics, errors } = poller([36, 40, 55, 71, 80]);
    expect((await p.poll()).status).toBe("ok");
    expect(flags.current()).toMatchObject({ relay_video_max_kbps: 300, private_mode_enabled: true, turn_enabled: true });
    await p.poll(); // still step 1: nothing new
    expect(await stepCount(metrics, "relay-bitrate")).toBe(1);
    await p.poll();
    expect(flags.current()).toMatchObject({ private_mode_enabled: false, turn_enabled: true });
    expect(await p.poll()).toMatchObject({ applied: ["turn-off"] });
    expect(flags.current().turn_enabled).toBe(false);
    expect(await p.poll()).toMatchObject({ applied: [] });
    expect(errors.length).toBe(3);
    for (const s of ["relay-bitrate", "private-mode-off", "turn-off"]) expect(await stepCount(metrics, s)).toBe(1);
  });

  test("a big jump applies every step at once", async () => {
    const { p, flags } = poller([100]);
    expect(await p.poll()).toMatchObject({ applied: ["relay-bitrate", "private-mode-off", "turn-off"] });
    expect(flags.current()).toMatchObject({ relay_video_max_kbps: 300, private_mode_enabled: false, turn_enabled: false });
  });

  test("an operator's lower relay cap is left alone", async () => {
    const { p, flags } = poller([40]);
    await flags.set({ relay_video_max_kbps: 200 });
    expect(await p.poll()).toMatchObject({ applied: [] });
    expect(flags.current().relay_video_max_kbps).toBe(200);
  });

  test("query failures are counted and change nothing", async () => {
    const { p, flags, metrics } = poller([NaN]);
    expect(await p.poll()).toEqual({ status: "error" });
    expect(flags.current().turn_enabled).toBe(true);
    expect((await metrics.turnSpendPollErrorsTotal.get()).values[0]!.value).toBe(1);
  });
});

const url = process.env.REDIS_URL;
describe.skipIf(!url)("TurnSpendPoller with Redis", () => {
  let redis: Redis | undefined;
  afterEach(async () => {
    await redis?.quit();
    redis = undefined;
  });

  test("only one instance polls per interval", async () => {
    redis = new Redis(url!);
    const lockKey = `test:${randomUUID()}:lock:turn-spend`;
    const a = poller([10], { redis, lockKey });
    const b = poller([10], { redis, lockKey });
    const [ra, rb] = await Promise.all([a.p.poll(), b.p.poll()]);
    expect([ra.status, rb.status].sort()).toEqual(["ok", "skipped"]);
    expect(await redis.pttl(lockKey)).toBeGreaterThan(50_000);
    await redis.del(lockKey);
  });
});
