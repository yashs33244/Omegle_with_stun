/**
 * The session gate end to end: POST /api/session, GET /api/config, the
 * Socket.IO handshake, the matching gate (kill switch, staffed hours,
 * max_waiting, hourly caps) and the status broadcast.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { io as ioClient } from "socket.io-client";
import type { Config } from "../../src/config";
import { FlagsReader, MemoryFlagsStore } from "../../src/flags/flags";
import { TOS_VERSION, type PublicConfig, type Restriction } from "../../src/protocol";
import { startMatchingBroadcast } from "../../src/session/broadcast";
import { TokenSigner } from "../../src/session/tokens";
import type { FetchFn } from "../../src/turn/cloudflare";
import {
  type Client,
  arrives,
  connectWithSession,
  hello,
  next,
  postSession,
  record,
  sendHello,
  sessionBody,
  startServer,
  type TestServer,
} from "../helpers";

let ts: TestServer;
afterEach(async () => {
  await ts?.close();
});

const PASS_SECRET = "1x0000000000000000000000000000000AA";
const FAIL_SECRET = "2x0000000000000000000000000000000AA";
const SITE_KEY = "1x00000000000000000000AA";

/** Mimics Cloudflare's test secrets without touching the network. */
function fakeSiteverify(calls: URLSearchParams[] = []): FetchFn {
  return async (_url, init) => {
    const body = init?.body as URLSearchParams;
    calls.push(body);
    const ok = body.get("secret") === PASS_SECRET && Boolean(body.get("response"));
    return Response.json({ success: ok, "error-codes": ok ? [] : ["invalid-input-secret"] });
  };
}

const gated = (overrides: Partial<Config> = {}, deps: Parameters<typeof startServer>[2] = {}) =>
  startServer({ requireSession: true, ...overrides }, undefined, { fetch: fakeSiteverify(), ...deps });

/** Waits for connect or connect_error; resolves with the error code or "connected". */
function tryConnect(ts: TestServer, opts: { auth?: Record<string, unknown>; headers?: Record<string, string> }) {
  const client: Client = ioClient(ts.url, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    auth: opts.auth,
    extraHeaders: opts.headers,
  });
  ts.clients.push(client);
  return new Promise<string>((resolve) => {
    client.once("connect", () => resolve("connected"));
    client.once("connect_error", (err) => resolve((err as Error & { data?: { code?: string } }).data?.code ?? err.message));
  });
}

describe("POST /api/session", () => {
  test("issues a session token and an age token for an adult", async () => {
    ts = await gated();
    const body = sessionBody();
    const res = await postSession(ts, body);
    expect(res.status).toBe(200);
    if (!res.body.ok) throw new Error(res.body.error);
    expect(res.body.country).toBeNull();
    expect(res.body.sessionExpiresAt - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(res.body.ageExpiresAt - Date.now()).toBeGreaterThan(179 * 24 * 3600_000);
    const signer = new TokenSigner([ts.config.sessionSecret]);
    expect(signer.verifySession(res.body.sessionToken, Date.now())?.deviceId).toBe(body.deviceId);
    const age = signer.verifyAge(res.body.ageToken, Date.now());
    expect(age).toMatchObject({ deviceId: body.deviceId, over18: true, tosVersion: TOS_VERSION });
    // The date of birth appears nowhere in what the server hands back.
    expect(JSON.stringify(res.body)).not.toContain("1990");
    for (const t of [res.body.sessionToken, res.body.ageToken]) {
      expect(Buffer.from(t.split(".")[1]!, "base64url").toString()).not.toContain("1990");
    }
  });

  test("Turnstile pass and fail (injected Siteverify)", async () => {
    const calls: URLSearchParams[] = [];
    ts = await gated({ turnstileSecret: PASS_SECRET, turnstileSiteKey: SITE_KEY }, { fetch: fakeSiteverify(calls) });
    expect((await postSession(ts, sessionBody())).status).toBe(200);
    expect(calls[0]?.get("response")).toBe("test-token");
    expect(calls[0]?.get("remoteip")).toBe("127.0.0.1");
    const missing = await postSession(ts, sessionBody({ turnstileToken: undefined }));
    expect(missing).toEqual({ status: 403, body: { ok: false, error: "turnstile_failed" } });
    await ts.close();

    ts = await gated({ turnstileSecret: FAIL_SECRET, turnstileSiteKey: SITE_KEY });
    expect((await postSession(ts, sessionBody())).body).toEqual({ ok: false, error: "turnstile_failed" });
  });

  test("an under-18 date of birth locks the device and its fingerprint on that network out", async () => {
    ts = await gated();
    const deviceId = randomUUID();
    const fingerprint = "c".repeat(64);
    const today = new Date();
    const seventeen = `${today.getUTCFullYear() - 17}-01-01`;
    const child = await postSession(ts, sessionBody({ deviceId, fingerprint, age: { dob: seventeen, attest18: true, tosVersion: TOS_VERSION } }));
    expect(child).toEqual({ status: 403, body: { ok: false, error: "underage" } });

    // No "go back and retry" with an adult date, a new device id, or the same device elsewhere.
    expect((await postSession(ts, sessionBody({ deviceId, fingerprint }))).body).toEqual({ ok: false, error: "locked" });
    expect((await postSession(ts, sessionBody({ fingerprint }))).body).toEqual({ ok: false, error: "locked" });
    expect((await postSession(ts, sessionBody({ deviceId }))).body).toEqual({ ok: false, error: "locked" });
    // A different browser fingerprint on a different device is someone else.
    expect((await postSession(ts, sessionBody())).status).toBe(200);
  });

  test("rejects invalid dates, malformed bodies and outdated Terms", async () => {
    ts = await gated({ sessionRatePerIpPerMin: 100 });
    const dob = (d: string) => sessionBody({ age: { dob: d, attest18: true, tosVersion: TOS_VERSION } });
    expect((await postSession(ts, dob("2999-01-01"))).body).toEqual({ ok: false, error: "invalid" });
    expect((await postSession(ts, dob("1850-01-01"))).body).toEqual({ ok: false, error: "invalid" });
    expect((await postSession(ts, dob("2001-02-30"))).body).toEqual({ ok: false, error: "invalid" });
    expect((await postSession(ts, { deviceId: "nope" })).status).toBe(400);
    const outdated = sessionBody({ age: { dob: "1990-01-01", attest18: true, tosVersion: "2020-old" } });
    expect(await postSession(ts, outdated)).toEqual({ status: 400, body: { ok: false, error: "tos_outdated" } });

    const broken = await fetch(`${ts.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"age":{"dob":"2010-01-01"',
    });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ ok: false, error: "invalid" });
    const huge = await fetch(`${ts.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(20_000) }),
    });
    expect(huge.status).toBe(413);
  });

  test("a returning device uses its age token instead of the date of birth", async () => {
    ts = await gated({ sessionRatePerIpPerMin: 100 });
    const first = sessionBody();
    const res = await postSession(ts, first);
    if (!res.body.ok) throw new Error(res.body.error);
    const again = await postSession(ts, { ...first, age: { ageToken: res.body.ageToken, tosVersion: TOS_VERSION } });
    expect(again.status).toBe(200);
    if (!again.body.ok) throw new Error(again.body.error);
    expect(again.body.ageToken).toBe(res.body.ageToken);
    expect(again.body.ageExpiresAt).toBe(res.body.ageExpiresAt);

    const otherDevice = await postSession(ts, sessionBody({ age: { ageToken: res.body.ageToken, tosVersion: TOS_VERSION } }));
    expect(otherDevice).toEqual({ status: 401, body: { ok: false, error: "age_token_invalid" } });
    const garbage = await postSession(ts, { ...first, age: { ageToken: "c1.e30.AAAA", tosVersion: TOS_VERSION } });
    expect(garbage.body).toEqual({ ok: false, error: "age_token_invalid" });
    const stale = await postSession(ts, { ...first, age: { ageToken: res.body.ageToken, tosVersion: "2020-old" } });
    expect(stale.body).toEqual({ ok: false, error: "tos_outdated" });
    // A session token is not accepted as an age token.
    const swapped = await postSession(ts, { ...first, age: { ageToken: res.body.sessionToken, tosVersion: TOS_VERSION } });
    expect(swapped.body).toEqual({ ok: false, error: "age_token_invalid" });
  });

  test("country blocklist via CF-IPCountry, only when Cloudflare is trusted", async () => {
    ts = await gated({ trustCloudflare: true, sessionRatePerIpPerMin: 100 });
    expect(await postSession(ts, sessionBody(), { "CF-IPCountry": "GB" })).toEqual({
      status: 403,
      body: { ok: false, error: "region_blocked" },
    });
    expect((await postSession(ts, sessionBody(), { "CF-IPCountry": "FR" })).body).toEqual({ ok: false, error: "region_blocked" });
    const us = await postSession(ts, sessionBody(), { "CF-IPCountry": "US" });
    expect(us.body).toMatchObject({ ok: true, country: "US" });
    await ts.server.flags.set({ blocked_countries: "US" });
    expect((await postSession(ts, sessionBody(), { "CF-IPCountry": "US" })).body).toEqual({ ok: false, error: "region_blocked" });
    expect((await postSession(ts, sessionBody(), { "CF-IPCountry": "GB" })).status).toBe(200);
    await ts.close();

    ts = await gated({ trustCloudflare: false });
    const spoofed = await postSession(ts, sessionBody(), { "CF-IPCountry": "GB" });
    expect(spoofed.body).toMatchObject({ ok: true, country: null });
  });

  test("the kill switch, active restrictions and the per-IP rate limit", async () => {
    const restriction: Restriction = {
      id: randomUUID(),
      reason: "harassment",
      kind: "pause",
      until: Date.now() + 600_000,
      createdAt: Date.now(),
      evidenceAvailable: true,
      appeal: { status: "none" },
      appealable: true,
    };
    const restricted = randomUUID();
    const seen: string[] = [];
    const noted: [string, string | null, string | null][] = [];
    ts = await gated(
      { sessionRatePerIpPerMin: 3 },
      {
        restrictions: {
          activeForDevice: async (deviceId, fingerprint) => {
            seen.push(fingerprint);
            return deviceId === restricted ? restriction : null;
          },
          noteDeviceNetwork: async (deviceId, ip, country) => {
            noted.push([deviceId, ip, country]);
          },
        },
      },
    );
    expect(await postSession(ts, sessionBody({ deviceId: restricted }))).toEqual({
      status: 403,
      body: { ok: false, error: "banned", restriction },
    });
    expect(seen[0]).toBe("a".repeat(64));
    expect(noted).toEqual([]);
    await ts.server.flags.set({ new_sessions_enabled: false });
    expect(await postSession(ts, sessionBody())).toEqual({ status: 503, body: { ok: false, error: "closed" } });
    await ts.server.flags.set({ new_sessions_enabled: true });
    const issued = sessionBody();
    expect((await postSession(ts, issued)).status).toBe(200);
    expect(noted).toEqual([[issued.deviceId, "127.0.0.1", null]]);
    expect(await postSession(ts, sessionBody())).toEqual({ status: 429, body: { ok: false, error: "rate_limited" } });
  });

  test("without an injected checker the gate uses the enforcement lane: a restriction follows the device and its fingerprint", async () => {
    ts = await gated({ sessionRatePerIpPerMin: 100 });
    const fingerprint = "f".repeat(64);
    const banned = sessionBody({ fingerprint });
    expect((await postSession(ts, banned)).status).toBe(200);
    // Another device of the same browser was seen before the restriction.
    const sibling = sessionBody({ fingerprint });
    expect((await postSession(ts, sibling)).status).toBe(200);

    const { reportId } = await ts.server.enforcement.submitReport({
      roomId: randomUUID(),
      reporterDevice: randomUUID(),
      reportedDevice: banned.deviceId,
      reason: "harassment",
      frame: null,
      activeSince: Date.now() - 60_000,
      endedAt: null,
    });
    const action = await ts.server.enforcement.actOnReport(reportId, { action: "restrict", durationMs: 86_400_000 }, { ip: null });
    if (!action.ok || !action.value.restriction) throw new Error("restrict did not apply");
    const id = action.value.restriction.id;

    expect(await postSession(ts, banned)).toMatchObject({ status: 403, body: { ok: false, error: "banned", restriction: { id } } });
    expect(await postSession(ts, sessionBody({ fingerprint }))).toMatchObject({ status: 403, body: { error: "banned", restriction: { id } } });
    expect((await postSession(ts, sessionBody({ fingerprint: "e".repeat(64) }))).status).toBe(200);
    // The sibling device got its token before the restriction: hello still refuses it via the stored link.
    expect(await ts.server.enforcement.activeForDevice(sibling.deviceId)).toMatchObject({ id });
    // Network facts noted at the gate reach the CSAM packet.
    const escalated = await ts.server.enforcement.escalate(reportId, { ip: null });
    if (!escalated.ok) throw new Error(escalated.error);
    expect(escalated.value.packet).toMatchObject({ reportedIpAddress: "127.0.0.1", reportedCountry: null });
  });
});

describe("GET /api/config", () => {
  test("public config from env and flags, cacheable for 30 s", async () => {
    ts = await gated({
      turnstileSecret: PASS_SECRET,
      turnstileSiteKey: SITE_KEY,
      sentryDsnFrontend: "https://pub@o1.ingest.sentry.io/2",
      posthogKey: "phc_test",
      posthogHost: "https://eu.i.posthog.com",
    });
    await ts.server.flags.set({ banner_message: "Hello", default_mode: "preview", private_mode_enabled: false });
    const res = await fetch(`${ts.url}/api/config`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    const body = (await res.json()) as PublicConfig;
    expect(body).toEqual({
      tosVersion: TOS_VERSION,
      turnstileSiteKey: SITE_KEY,
      sentryDsn: "https://pub@o1.ingest.sentry.io/2",
      posthogKey: "phc_test",
      posthogHost: "https://eu.i.posthog.com",
      banner: "Hello",
      matchingOpen: true,
      staffedHours: null,
      reopensAt: null,
      defaultMode: "preview",
      privateModeEnabled: false,
    });
  });

  test("reports closed matching and the staffed window; no site key without a secret", async () => {
    ts = await gated();
    // A one-minute window that is never "now" for the next hour.
    const later = new Date(Date.now() + 2 * 3600_000);
    const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const end = new Date(later.getTime() + 60_000);
    await ts.server.flags.set({ staffed_hours: `${hhmm(later)}-${hhmm(end)} Etc/UTC` });
    const body = (await (await fetch(`${ts.url}/api/config`)).json()) as PublicConfig;
    expect(body.turnstileSiteKey).toBeNull();
    expect(body.staffedHours).toContain("(Etc/UTC)");
    expect(body.matchingOpen).toBe(false);
    expect(body.reopensAt).toBeGreaterThan(Date.now());
  });

  test("CORS for allowed origins, including the preflight", async () => {
    ts = await gated({ corsOrigins: ["https://app.example"] });
    const ok = await fetch(`${ts.url}/api/config`, { headers: { origin: "https://app.example" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const other = await fetch(`${ts.url}/api/config`, { headers: { origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await fetch(`${ts.url}/api/session`, {
      method: "OPTIONS",
      headers: { origin: "https://app.example", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("Content-Type");
  });
});

describe("Socket.IO handshake", () => {
  test("rejects missing, bad and expired tokens", async () => {
    ts = await gated();
    const signer = new TokenSigner([ts.config.sessionSecret]);
    const expired = signer.sign({ kind: "session", deviceId: randomUUID(), country: null, iat: 0, exp: Date.now() - 1 });
    const foreign = new TokenSigner(["z".repeat(32)]).sign({
      kind: "session",
      deviceId: randomUUID(),
      country: null,
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const age = signer.sign({ kind: "age", deviceId: randomUUID(), over18: true, tosVersion: TOS_VERSION, iat: 0, exp: Date.now() + 60_000 });
    expect(await tryConnect(ts, {})).toBe("session_required");
    expect(await tryConnect(ts, { auth: { sessionToken: "nope" } })).toBe("session_required");
    expect(await tryConnect(ts, { auth: { sessionToken: expired } })).toBe("session_required");
    expect(await tryConnect(ts, { auth: { sessionToken: foreign } })).toBe("session_required");
    expect(await tryConnect(ts, { auth: { sessionToken: age } })).toBe("session_required");
  });

  test("rejects blocked regions by the token and by the current edge header", async () => {
    ts = await gated({ trustCloudflare: true });
    const signer = new TokenSigner([ts.config.sessionSecret]);
    const token = (country: string | null) =>
      signer.sign({ kind: "session", deviceId: randomUUID(), country, iat: Date.now(), exp: Date.now() + 60_000 });
    expect(await tryConnect(ts, { auth: { sessionToken: token("AU") } })).toBe("region_blocked");
    expect(await tryConnect(ts, { auth: { sessionToken: token("US") }, headers: { "CF-IPCountry": "GB" } })).toBe(
      "region_blocked",
    );
    expect(await tryConnect(ts, { auth: { sessionToken: token("US") }, headers: { "CF-IPCountry": "US" } })).toBe("connected");
    expect(await tryConnect(ts, { auth: { sessionToken: token(null) } })).toBe("connected");
  });

  test("session:hello must use the token's deviceId; gated users match end to end", async () => {
    ts = await gated();
    const a = await connectWithSession(ts);
    const b = await connectWithSession(ts);
    expect(await sendHello(a.client, hello())).toMatchObject({ ok: false, error: "invalid_payload" });
    const found = next(a.client, "match:found");
    expect(await sendHello(a.client, hello({ deviceId: a.deviceId }))).toMatchObject({ ok: true });
    expect(await sendHello(b.client, hello({ deviceId: b.deviceId }))).toMatchObject({ ok: true });
    expect((await found).roomId).toBeString();
  });
});

describe("matching gate", () => {
  test("the kill switch refuses hellos, pauses matching and broadcasts status and banner", async () => {
    ts = await gated();
    const a = await connectWithSession(ts);
    const b = await connectWithSession(ts);
    const c = await connectWithSession(ts);
    // a and b wait but cannot match each other yet (language filter).
    await sendHello(a.client, hello({ deviceId: a.deviceId, preferences: { genderFilter: "all", languageFilter: "hi" } }));
    await sendHello(b.client, hello({ deviceId: b.deviceId }));
    const statuses = record(c.client, "matching:status");
    const banners = record(c.client, "server:banner");

    await ts.server.flags.set({ matching_enabled: false, banner_message: "Back at 9 pm" });
    expect(await sendHello(c.client, hello({ deviceId: c.deviceId }))).toEqual({
      ok: false,
      error: "matching_closed",
      message: "Back at 9 pm",
    });
    // While closed, a change that would make a and b compatible does not match them.
    const matched = arrives(a.client, "match:found", 300);
    await a.client.timeout(1000).emitWithAck("session:preferences", { preferences: { genderFilter: "all", languageFilter: "any" } });
    expect(await matched).toBe(false);

    const reopened = next(a.client, "matching:status");
    const cBannerCleared = next(c.client, "server:banner");
    const found = next(a.client, "match:found");
    await ts.server.flags.set({ matching_enabled: true, banner_message: "" });
    expect(await reopened).toEqual({ open: true, reopensAt: null, message: null });
    expect((await found).roomId).toBeString();
    await cBannerCleared; // emitted after matching:status on the same socket
    expect(statuses).toEqual([
      { open: false, reopensAt: null, message: "Back at 9 pm" },
      { open: true, reopensAt: null, message: null },
    ]);
    expect(banners).toEqual([{ message: "Back at 9 pm" }, { message: null }]);
    expect(await sendHello(c.client, hello({ deviceId: c.deviceId }))).toMatchObject({ ok: true });
  });

  test("max_waiting refuses new hellos once the queue is full", async () => {
    ts = await gated();
    await ts.server.flags.set({ max_waiting: 1 });
    const a = await connectWithSession(ts);
    const b = await connectWithSession(ts);
    await sendHello(a.client, hello({ deviceId: a.deviceId, preferences: { genderFilter: "all", languageFilter: "hi" } }));
    const res = await sendHello(b.client, hello({ deviceId: b.deviceId }));
    expect(res).toMatchObject({ ok: false, error: "matching_closed" });
    expect((res as { message?: string }).message).toMatch(/try again/i);
  });

  test("hourly match caps: the re-queue and new hellos are refused with rate_limited", async () => {
    ts = await gated({ matchCapPerDevicePerHour: 1 });
    const a = await connectWithSession(ts);
    const b = await connectWithSession(ts);
    const found = next(a.client, "match:found");
    await sendHello(a.client, hello({ deviceId: a.deviceId }));
    await sendHello(b.client, hello({ deviceId: b.deviceId }));
    await found;

    const errA = next(a.client, "server:error");
    const waitingA = arrives(a.client, "queue:waiting", 300);
    a.client.emit("call:skip");
    expect(await errA).toMatchObject({ code: "rate_limited" });
    expect(await waitingA).toBe(false);
    expect(await sendHello(a.client, hello({ deviceId: a.deviceId }))).toMatchObject({ ok: false, error: "rate_limited" });
  });

  test("the per-IP cap applies across devices on one address", async () => {
    ts = await gated({ matchCapPerIpPerHour: 2, sessionRatePerIpPerMin: 100 });
    const a = await connectWithSession(ts);
    const b = await connectWithSession(ts);
    const found = next(a.client, "match:found");
    await sendHello(a.client, hello({ deviceId: a.deviceId }));
    await sendHello(b.client, hello({ deviceId: b.deviceId }));
    await found; // two matches counted against 127.0.0.1
    const c = await connectWithSession(ts);
    expect(await sendHello(c.client, hello({ deviceId: c.deviceId }))).toMatchObject({ ok: false, error: "rate_limited" });
  });
});

describe("staffed-hours broadcast", () => {
  test("announces the boundary on the timer without a flag change", async () => {
    // 2026-10-04T14:29:00Z is 19:59 in Asia/Kolkata; the window opens at 20:00.
    let now = Date.UTC(2026, 9, 4, 14, 29);
    const flags = new FlagsReader(new MemoryFlagsStore());
    await flags.set({ staffed_hours: "20:00-24:00 Asia/Kolkata" });
    const sent: { event: string; payload: unknown }[] = [];
    const io = {
      local: {
        emit: (event: string, payload: unknown) => {
          sent.push({ event, payload });
          return true;
        },
      },
    };
    const stop = startMatchingBroadcast(io as never, flags, 10, () => now);
    await new Promise((r) => setTimeout(r, 40));
    expect(sent).toEqual([]);
    now += 60_000; // 20:00 IST
    await new Promise((r) => setTimeout(r, 40));
    expect(sent).toEqual([{ event: "matching:status", payload: { open: true, reopensAt: null, message: null } }]);
    now = Date.UTC(2026, 9, 4, 18, 31); // 00:01 IST next day: closed again until 20:00
    await new Promise((r) => setTimeout(r, 40));
    expect(sent[1]).toEqual({
      event: "matching:status",
      payload: { open: false, reopensAt: Date.UTC(2026, 9, 5, 14, 30), message: null },
    });
    stop();
  });
});

describe.skipIf(!process.env.REDIS_URL)("session gate on the shared Redis client", () => {
  test("lockouts and tokens are shared by replicas with the same SESSION_SECRET", async () => {
    const redis = new Redis(process.env.REDIS_URL!);
    const secret = randomUUID() + randomUUID();
    const one = await gated({ sessionSecret: secret }, { redis });
    const two = await gated({ sessionSecret: secret }, { redis });
    try {
      const fingerprint = "d".repeat(64);
      const deviceId = randomUUID();
      const dob = `${new Date().getUTCFullYear() - 15}-06-01`;
      const kid = sessionBody({ deviceId, fingerprint, age: { dob, attest18: true, tosVersion: TOS_VERSION } });
      expect((await postSession(one, kid)).body).toEqual({ ok: false, error: "underage" });
      expect((await postSession(two, sessionBody({ deviceId }))).body).toEqual({ ok: false, error: "locked" });
      expect((await postSession(two, sessionBody({ fingerprint }))).body).toEqual({ ok: false, error: "locked" });

      // A token from one replica opens a socket on the other.
      const res = await postSession(one, sessionBody());
      if (!res.body.ok) throw new Error(res.body.error);
      expect(await tryConnect(two, { auth: { sessionToken: res.body.sessionToken } })).toBe("connected");
    } finally {
      await one.close();
      await two.close();
      await redis.quit();
    }
  });
});
