/**
 * Report admission per client address and the admin restriction durations,
 * over a real server.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { REPORTS_PER_IP_PER_HOUR } from "../../src/enforcement/constants";
import { RESTRICTION_DURATIONS_MS, type Restriction } from "../../src/protocol";
import { activePair, hello, next, sendHello, startServer, type Client, type TestServer } from "../helpers";

const TOKEN = "admin-token-for-tests-0123456789";

let ts: TestServer;
afterEach(async () => {
  await ts?.close();
});

type ReportAck = { ok: boolean; reportId?: string; error?: string };

function report(client: Client, roomId: string): Promise<ReportAck> {
  return (client.timeout(2000).emitWithAck as (ev: string, p: unknown) => Promise<ReportAck>)("report:submit", { roomId, reason: "spam" });
}

/** An active pair where the reporter connects from `ip`; the partner is anywhere else. */
async function pairFrom(ip: string) {
  const reporter = await ts.connect({ headers: { "x-real-ip": ip } });
  const partner = await ts.connect({ headers: { "x-real-ip": `198.51.100.${Math.floor(Math.random() * 200) + 1}` } });
  const foundR = next(reporter, "match:found");
  const foundP = next(partner, "match:found");
  await sendHello(reporter, hello());
  await sendHello(partner, hello());
  const { roomId } = await foundR;
  await foundP;
  partner.disconnect();
  return { reporter, roomId };
}

describe("reports per address", () => {
  test("fresh device ids on one address share REPORTS_PER_IP_PER_HOUR; another address is unaffected", async () => {
    ts = await startServer({ proxyIpHeader: "x-real-ip", adminToken: TOKEN });
    const ip = "203.0.113.77";
    for (let i = 0; i < REPORTS_PER_IP_PER_HOUR; i++) {
      const { reporter, roomId } = await pairFrom(ip);
      expect((await report(reporter, roomId)).ok).toBe(true);
      reporter.disconnect();
    }
    const { reporter, roomId } = await pairFrom(ip);
    expect(await report(reporter, roomId)).toEqual({ ok: false, error: "rate_limited" });
    reporter.disconnect();
    const other = await pairFrom("203.0.113.78");
    expect((await report(other.reporter, other.roomId)).ok).toBe(true);
  }, 20_000);
});

describe("admin restriction durations", () => {
  test("only the ladder's durations (or null) are accepted", async () => {
    ts = await startServer({ adminToken: TOKEN });
    const { ca, roomId } = await activePair(ts);
    const ack = await report(ca, roomId);
    if (!ack.reportId) throw new Error("report failed");
    const act = (durationMs: unknown) =>
      fetch(`${ts.url}/admin/api/reports/${ack.reportId}/action`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restrict", durationMs }),
      });
    for (const bad of [1, 12_345, 3 * 86_400_000, 10 * 365 * 86_400_000, "600000", -600_000]) {
      expect((await act(bad)).status).toBe(400);
    }
    expect(await fetch(`${ts.url}/admin/api/audit?limit=5`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())).toEqual([]);
    const res = await act(RESTRICTION_DURATIONS_MS[0]);
    expect(res.status).toBe(200);
    const { restriction } = (await res.json()) as { restriction: Restriction };
    expect(restriction.until! - restriction.createdAt).toBe(RESTRICTION_DURATIONS_MS[0]);
    expect((await act(null)).status).toBe(200);
  });
});
