/**
 * Reports v2, restrictions, appeals, takedowns and the admin API end to end:
 * real server, real socket.io clients, real HTTP.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import Redis from "ioredis";
import type { Config } from "../../src/config";
import { DAY, SHORT_CALL_MS, YEAR } from "../../src/enforcement/constants";
import type { EnforcementStore } from "../../src/enforcement/EnforcementStore";
import { MemoryEnforcementStore } from "../../src/enforcement/MemoryEnforcementStore";
import { RedisEnforcementStore } from "../../src/enforcement/RedisEnforcementStore";
import type { AdminReport, CsamReportPacket, Restriction, RestrictionView } from "../../src/protocol";
import { jpegBytes, jpegDataUrl } from "../enforcementFixtures";
import {
  activePair,
  arrives,
  delay,
  hello,
  next,
  sendHello,
  startServer,
  type Client,
  type TestServer,
} from "../helpers";
import type { ServerDeps } from "../../src/server";
import { toDataUrl } from "../../src/enforcement/evidence";

const TOKEN = "admin-token-for-tests-0123456789";

let ts: TestServer;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await ts?.close();
  for (const fn of cleanups.splice(0)) await fn();
});

function boot(overrides: Partial<Config> = {}, enforcement: ServerDeps["enforcement"] = {}) {
  return startServer({ adminToken: TOKEN, ...overrides }, undefined, { enforcement });
}

/** A store the test can seed. Redis when the suite runs against Redis. */
function seedableStore(): EnforcementStore {
  if (process.env.TEST_STORE === "redis" && process.env.REDIS_URL) {
    const client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
    cleanups.push(() => client.quit());
    return new RedisEnforcementStore(client, `test:${randomUUID()}:enf:`);
  }
  return new MemoryEnforcementStore();
}

function admin(path: string, init: RequestInit & { token?: string | null; headers?: Record<string, string> } = {}) {
  const { token = TOKEN, headers = {}, ...rest } = init;
  return fetch(`${ts.url}/admin/api${path}`, {
    ...rest,
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
  });
}

async function adminJson<T>(path: string, init?: Parameters<typeof admin>[1]): Promise<T> {
  const res = await admin(path, init);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

function postJson(path: string, body: unknown) {
  return fetch(`${ts.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function reportAck(client: Client, payload: Parameters<Client["emit"]>[1]) {
  return (client.timeout(2000).emitWithAck as (ev: string, p: unknown) => Promise<{ ok: boolean; reportId?: string; error?: string; message?: string }>)(
    "report:submit",
    payload,
  );
}

describe("report v2 over the socket", () => {
  test("stores the frame, its hash and the chat lines; admins see pseudonyms and every evidence view is audited", async () => {
    ts = await boot();
    const { ca, roomId, a, b } = await activePair(ts);
    const bytes = jpegBytes(3_000);
    const ack = await reportAck(ca, {
      roomId,
      reason: "harassment",
      details: "rude",
      evidence: { frame: toDataUrl(bytes), chat: [{ from: "partner", text: "go away", ts: 5 }] },
    });
    expect(ack).toMatchObject({ ok: true });

    const queue = await adminJson<AdminReport[]>("/queue");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: ack.reportId,
      hasFrame: true,
      restricted: false,
      severity: "medium",
      chat: [{ from: "reported", text: "go away", ts: 5 }],
    });
    expect(JSON.stringify(queue)).not.toContain(a.deviceId);
    expect(JSON.stringify(queue)).not.toContain(b.deviceId);

    const image = await admin(`/reports/${ack.reportId}/evidence`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect(image.headers.get("cache-control")).toBe("no-store");
    expect(image.headers.get("content-disposition")).toBe(`attachment; filename="evidence-${ack.reportId}.jpg"`);
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([...bytes]);
    const audit = await adminJson<{ action: string; target: string; ip: string | null }[]>("/audit");
    expect(audit[0]).toMatchObject({ action: "report.view_evidence", target: ack.reportId });
  });

  test("a frame that is not a JPEG is refused and the call goes on", async () => {
    ts = await boot();
    const { ca, cb, roomId } = await activePair(ts);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    const ack = await reportAck(ca, { roomId, reason: "nudity", evidence: { frame: `data:image/jpeg;base64,${png}` } });
    expect(ack).toMatchObject({ ok: false, error: "invalid_payload" });
    const msg = next(cb, "chat:message");
    expect(await ca.timeout(1000).emitWithAck("chat:send", { roomId, text: "still here" })).toMatchObject({ ok: true });
    expect((await msg).text).toBe("still here");
    expect(await adminJson<AdminReport[]>("/queue")).toEqual([]);
  });

  test("accepted within the window after the call ended, once per room, refused after the window", async () => {
    ts = await boot({ reportAfterEndMs: 300 });
    const first = await activePair(ts);
    const ended = next(first.ca, "match:ended");
    first.cb.emit("call:skip");
    expect((await ended).reason).toBe("partner-skipped");
    expect(await reportAck(first.ca, { roomId: first.roomId, reason: "spam" })).toMatchObject({ ok: true });
    expect(await reportAck(first.ca, { roomId: first.roomId, reason: "spam" })).toMatchObject({
      ok: false,
      error: "bad_state",
      message: "already reported",
    });
    // The other member of the room can still report too.
    expect(await reportAck(first.cb, { roomId: first.roomId, reason: "spam" })).toMatchObject({ ok: true });
    first.ca.disconnect();
    first.cb.disconnect();

    const second = await activePair(ts);
    const ended2 = next(second.ca, "match:ended");
    second.cb.emit("call:skip");
    await ended2;
    await new Promise((r) => setTimeout(r, 400));
    expect(await reportAck(second.ca, { roomId: second.roomId, reason: "spam" })).toMatchObject({
      ok: false,
      error: "not_in_room",
    });
    // A stranger can never report a room they were not in.
    const stranger = await ts.connect();
    await sendHello(stranger, hello({ profile: { ...hello().profile, topics: ["books"] } }));
    expect(await reportAck(stranger, { roomId: second.roomId, reason: "spam" })).toMatchObject({ ok: false, error: "not_in_room" });
  });
});

describe("restrictions", () => {
  test("an admin restriction mid-call ends that side with 'restricted'; hello is then refused; an overturned appeal lets it back", async () => {
    ts = await boot();
    // A reports B; then B matches C and they are in a call.
    const ab = await activePair(ts);
    const { reportId } = (await reportAck(ab.ca, { roomId: ab.roomId, reason: "harassment" })) as { reportId: string };
    ab.ca.disconnect();
    const cc = await ts.connect();
    const foundB = next(ab.cb, "match:found");
    const foundC = next(cc, "match:found");
    await sendHello(cc, hello());
    const { roomId } = await foundB;
    await foundC;
    const startB = next(ab.cb, "call:start");
    ab.cb.emit("match:accept", { roomId });
    cc.emit("match:accept", { roomId });
    await startB;

    const endedB = next(ab.cb, "match:ended");
    const endedC = next(cc, "match:ended");
    const restrictedB = next(ab.cb, "session:restricted");
    const requeuedC = next(cc, "queue:waiting");
    const action = await adminJson<{ restriction: Restriction }>(`/reports/${reportId}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "restrict", durationMs: DAY, note: "confirmed" }),
    });
    expect(action.restriction).toMatchObject({ kind: "ban", reason: "harassment", appealable: true });
    expect(await endedB).toEqual({ roomId, reason: "restricted" });
    expect(await endedC).toEqual({ roomId, reason: "partner-skipped" });
    expect((await restrictedB).restriction.id).toBe(action.restriction.id);
    await requeuedC;
    expect(await arrives(ab.cb, "queue:waiting", 200)).toBe(false);

    // A fresh socket for the same device is refused with the restriction.
    const again = await ts.connect();
    const refused = await sendHello(again, ab.b);
    expect(refused).toMatchObject({ ok: false, error: "banned", restriction: { id: action.restriction.id } });

    // The device reads its restriction and appeals once.
    const view = (await (
      await fetch(`${ts.url}/api/restrictions/${action.restriction.id}?deviceId=${ab.b.deviceId}`)
    ).json()) as RestrictionView;
    expect(view).toMatchObject({ restriction: { id: action.restriction.id }, evidenceFrame: null });
    expect((await fetch(`${ts.url}/api/restrictions/${action.restriction.id}?deviceId=${randomUUID()}`)).status).toBe(404);
    expect((await fetch(`${ts.url}/api/restrictions/nope?deviceId=${ab.b.deviceId}`)).status).toBe(400);
    const appealBody = { restrictionId: action.restriction.id, deviceId: ab.b.deviceId, text: "I did nothing wrong, please check." };
    const appeal = await postJson("/api/appeals", appealBody);
    expect(appeal.status).toBe(201);
    expect(await appeal.json()).toMatchObject({ ok: true });
    const dup = await postJson("/api/appeals", appealBody);
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ ok: false, error: "already_appealed" });
    expect((await postJson("/api/appeals", { ...appealBody, text: "short" })).status).toBe(400);

    const appeals = await adminJson<{ id: string; status: string }[]>("/appeals");
    expect(appeals[0]!.status).toBe("pending");
    const decided = await adminJson<{ status: string }>(`/appeals/${appeals[0]!.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "overturn", note: "context missing" }),
    });
    expect(decided.status).toBe("overturned");
    expect(await sendHello(again, ab.b)).toMatchObject({ ok: true });
    const actions = (await adminJson<{ action: string }[]>("/audit")).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["report.restrict", "appeal.overturn"]));
  });

  test("weighted reports from established devices on distinct addresses pause the reported device for 10 min", async () => {
    const store = seedableStore();
    ts = await boot({ proxyIpHeader: "x-real-ip" }, { store });
    const established = async () => {
      const h = hello();
      await store.setFieldIfAbsent(`dev:${h.deviceId}`, "firstSeen", Date.now() - 4 * DAY, YEAR);
      await store.incrField(`dev:${h.deviceId}`, "completedCalls", 10, YEAR);
      return h;
    };
    const target = hello();
    const ct = await ts.connect();
    await sendHello(ct, target);
    const restricted = next(ct, "session:restricted", 10_000);

    for (let i = 0; i < 2; i++) {
      const r = await ts.connect({ headers: { "x-real-ip": `198.51.100.${10 + i}` } });
      const foundT = next(ct, "match:found");
      const foundR = next(r, "match:found");
      await sendHello(r, await established());
      const { roomId } = await foundR;
      await foundT;
      // Reports on calls shorter than 2 s count half, so connect and talk a little first.
      const started = next(r, "call:start");
      ct.emit("match:accept", { roomId });
      r.emit("match:accept", { roomId });
      await started;
      await delay(SHORT_CALL_MS + 100);
      expect(await reportAck(r, { roomId, reason: "hate" })).toMatchObject({ ok: true });
      r.disconnect();
    }
    const { restriction } = await restricted;
    expect(restriction).toMatchObject({ kind: "pause", reason: "hate" });
    expect(restriction.until! - restriction.createdAt).toBe(10 * 60_000);
    expect((await ts.store.getSession(ct.id!))!.state).toBe("idle");
    expect(await ts.store.getBan(target.deviceId)).toBe(restriction.until);
  }, 15_000);

  test("suspected CSAM: restricted path, no evidence for the console or the user, escalation packet and ban", async () => {
    ts = await boot();
    const { ca, cb, roomId, b } = await activePair(ts);
    const frame = jpegDataUrl(2_500);
    const ack = await reportAck(ca, { roomId, reason: "underage", evidence: { frame } });
    expect(ack.ok).toBe(true);
    // One fresh reporter does not pause anyone.
    expect(await ts.server.enforcement.activeForDevice(b.deviceId)).toBeNull();

    const [item] = await adminJson<AdminReport[]>("/queue");
    expect(item).toMatchObject({ id: ack.reportId, severity: "critical", restricted: true, hasFrame: true });
    const denied = await admin(`/reports/${ack.reportId}/evidence`);
    expect(denied.status).toBe(403);

    const restricted = next(cb, "session:restricted");
    const res = await adminJson<{ packet: CsamReportPacket; restriction: Restriction }>(`/reports/${ack.reportId}/escalate`, {
      method: "POST",
      body: JSON.stringify({ note: "filed with NCMEC" }),
    });
    const sha = createHash("sha256").update(new Uint8Array(Buffer.from(frame.split(",")[1]!, "base64"))).digest("hex");
    expect(res.packet).toMatchObject({ reportId: ack.reportId, humanViewed: false, evidenceSha256: sha, reason: "underage" });
    expect(res.packet.evidencePreservedUntil - res.packet.generatedAt).toBe(YEAR);
    expect(res.restriction).toMatchObject({ reason: "minor-safety", until: null, evidenceAvailable: false });
    expect((await restricted).restriction.reason).toBe("minor-safety");

    const view = (await (
      await fetch(`${ts.url}/api/restrictions/${res.restriction.id}?deviceId=${b.deviceId}`)
    ).json()) as RestrictionView;
    expect(view.evidenceFrame).toBeNull();
    const release = (body: unknown) =>
      admin(`/reports/${ack.reportId}/release-hold`, { method: "POST", body: JSON.stringify(body) });
    expect((await release({ note: "x".repeat(2_001) })).status).toBe(400);
    const released = await release({ note: "case closed" });
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ id: ack.reportId, status: "escalated" });
    expect((await release({})).status).toBe(409); // no hold left
    const audit = (await adminJson<{ action: string }[]>("/audit")).map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["report.evidence_denied", "report.escalate_csam", "report.release_hold"]));
  });
});

describe("admin API access", () => {
  test("closed without a configured token", async () => {
    ts = await startServer();
    const res = await admin("/queue");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "admin_disabled" });
  });

  test("no token or a wrong token is 401; repeated failures lock the IP out", async () => {
    ts = await boot();
    expect((await admin("/queue", { token: null })).status).toBe(401);
    expect((await admin("/queue", { token: "wrong" })).status).toBe(401);
    expect((await admin("/queue", { token: `${TOKEN}x` })).status).toBe(401);
    expect((await admin("/queue")).status).toBe(200);
    for (let i = 0; i < 8; i++) await admin("/queue", { token: "wrong" });
    const locked = await admin("/queue");
    expect(locked.status).toBe(429);
  });

  test("ADMIN_ALLOWED_IPS honors X-Real-IP only behind a trusted proxy", async () => {
    ts = await boot({ proxyIpHeader: "x-real-ip", adminAllowedIps: ["203.0.113.5"] });
    expect((await admin("/queue", { headers: { "X-Real-IP": "203.0.113.5" } })).status).toBe(200);
    expect((await admin("/queue", { headers: { "X-Real-IP": "203.0.113.6" } })).status).toBe(403);
    expect((await admin("/queue")).status).toBe(403);
    await ts.close();

    ts = await boot({ proxyIpHeader: null, adminAllowedIps: ["203.0.113.5"] });
    expect((await admin("/queue", { headers: { "X-Real-IP": "203.0.113.5" } })).status).toBe(403);
    await ts.close();

    ts = await boot({ proxyIpHeader: null, adminAllowedIps: ["127.0.0.1"] });
    expect((await admin("/queue", { headers: { "X-Real-IP": "203.0.113.9" } })).status).toBe(200);
  });

  test("CORS for the console on an allowed origin, preflight before the token check", async () => {
    ts = await boot({ corsOrigins: ["https://app.example"] });
    const pre = await admin("/queue", {
      method: "OPTIONS",
      token: null,
      headers: {
        Origin: "https://app.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(pre.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
    const ok = await admin("/queue", { headers: { Origin: "https://app.example" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const denied = await admin("/queue", { token: null, headers: { Origin: "https://app.example" } });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const other = await admin("/queue", { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("validation, unknown ids and malformed JSON", async () => {
    ts = await boot();
    expect((await admin("/reports/not-a-uuid")).status).toBe(404);
    expect((await admin(`/reports/${randomUUID()}`)).status).toBe(404);
    expect((await admin(`/reports/${randomUUID()}/action`, { method: "POST", body: JSON.stringify({ action: "nuke" }) })).status).toBe(400);
    expect((await admin(`/reports/${randomUUID()}/action`, { method: "POST", body: JSON.stringify({ action: "warn" }) })).status).toBe(404);
    expect((await admin("/queue?status=bogus")).status).toBe(400);
    expect((await admin("/nothing-here")).status).toBe(404);
    const bad = await admin("/flags", { method: "PUT", body: "{not json" });
    expect(bad.status).toBe(400);
  });

  test("flags: read, validated partial update, audited", async () => {
    ts = await boot();
    const flags = await adminJson<{ matching_enabled: boolean }>("/flags");
    expect(flags.matching_enabled).toBe(true);
    expect((await admin("/flags", { method: "PUT", body: JSON.stringify({ max_waiting: -1 }) })).status).toBe(400);
    expect((await admin("/flags", { method: "PUT", body: JSON.stringify({ unknown_flag: 1 }) })).status).toBe(400);
    expect((await admin("/flags", { method: "PUT", body: JSON.stringify({}) })).status).toBe(400);
    const updated = await adminJson<{ banner_message: string }>("/flags", {
      method: "PUT",
      body: JSON.stringify({ banner_message: "Back at 8 pm" }),
    });
    expect(updated.banner_message).toBe("Back at 8 pm");
    expect(ts.server.flags.current().banner_message).toBe("Back at 8 pm");
    const [entry] = await adminJson<{ action: string; target: string }[]>("/audit?limit=1");
    expect(entry).toMatchObject({ action: "flags.update", target: "banner_message" });
  });
});

describe("takedowns", () => {
  const body = {
    kind: "ncii",
    contactEmail: "person@example.com",
    description: "A frame of me was captured in a report and I want it removed.",
    isAffectedPerson: true,
    goodFaithStatement: true,
    turnstileToken: "pass",
  };

  test("Turnstile-verified tickets with a 48 h clock that admins resolve", async () => {
    ts = await boot({}, { turnstile: async (token) => token === "pass" });
    expect((await postJson("/api/takedowns", { ...body, goodFaithStatement: false })).status).toBe(400);
    const failed = await postJson("/api/takedowns", { ...body, turnstileToken: "fail" });
    expect(failed.status).toBe(403);
    expect(await failed.json()).toEqual({ ok: false, error: "turnstile_failed" });
    const created = await postJson("/api/takedowns", body);
    expect(created.status).toBe(201);
    const { ticketId } = (await created.json()) as { ticketId: string };

    const [ticket] = await adminJson<{ id: string; dueAt: number; createdAt: number; status: string }[]>("/takedowns");
    expect(ticket).toMatchObject({ id: ticketId, status: "open" });
    expect(ticket!.dueAt - ticket!.createdAt).toBe(2 * DAY);
    const resolved = await adminJson<{ status: string }>(`/takedowns/${ticketId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution: "Evidence frame deleted." }),
    });
    expect(resolved.status).toBe("resolved");
    expect((await adminJson<{ action: string }[]>("/audit"))[0]!.action).toBe("takedown.resolve");
  });

  test("the default verifier calls Cloudflare through the injected fetch with the test secret", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ success: false }));
    }) as unknown as typeof fetch;
    ts = await boot({ turnstileSecret: "2x0000000000000000000000000000000AA" }, { fetch: fakeFetch });
    expect((await postJson("/api/takedowns", body)).status).toBe(403);
    expect(calls).toBe(1);
  });
});

describe("hello", () => {
  test("records first sight of a device for reporter weighting", async () => {
    const store = seedableStore();
    ts = await boot({}, { store });
    const c = await ts.connect();
    const h = hello();
    await sendHello(c, h);
    expect((await store.getFields(`dev:${h.deviceId}`)).firstSeen).toBeGreaterThan(0);
  });
});
