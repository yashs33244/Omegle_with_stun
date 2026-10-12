/**
 * Property: every REST route of docs/PROTOCOL.md section 4, under arbitrary
 * methods, path ids, query strings, headers (Content-Type variants, duplicated
 * header lines, encodings, a lying Content-Length) and bodies, answers
 *   - without a 5xx other than the documented 503s (and 502 upstream on billing);
 *   - with JSON (except a HEAD, a 204 preflight and the two non-JSON successes:
 *     /metrics text and the admin evidence JPEG);
 *   - without a stack trace or an internal path in the body;
 *   - with the documented Cache-Control on a success, and never a public one on an error;
 *   - within a bounded time.
 * Requests go over raw TCP so duplicated header lines reach the server as sent.
 * Each request comes from its own client IP (PROXY_IP_HEADER) so the per-IP
 * buckets do not turn the run into a test of 429s; admin requests carry the
 * valid token, billing ones a valid session, most of the time.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import pino from "pino";
import { FAKE_SIGNATURE } from "../../src/billing";
import { webhookSignature } from "../../src/billing/razorpay";
import {
  ADMIN_BODY_LIMIT_BYTES,
  BILLING_BODY_LIMIT_BYTES,
  ENFORCEMENT_BODY_LIMIT_BYTES,
  SESSION_BODY_LIMIT_BYTES,
  WEBHOOK_BODY_LIMIT_BYTES,
} from "../../src/http/constants";
import { TOS_VERSION } from "../../src/protocol";
import { postSession, sessionBody, startServer, type TestServer } from "../helpers";
import { EDGE_STRINGS, Ref, SEED, deepNesting, extended, hugeString, leaf, mutated, obj, shortString, toJsonText, tree, type Fuzz, type Obj } from "./arbitraries";

const ADMIN = "a".repeat(32);
const WEBHOOK_SECRET = "whsec_fuzz";
/** A local request answered later than this is a hang, whatever the route does. */
const RESPONSE_BUDGET_MS = 2_000;
/** Guard for the failure mode (a server that holds the connection); the pass path resolves on the server's close. */
const HANG_MS = 5_000;
/** Session tokens the billing requests are spread over. */
const SESSIONS = 8;
/** Bodies, stack frames and paths that must never reach a client. */
const LEAK = /(\bat\s+\S+\s+\(|node_modules|\/src\/|\/Users\/|\/home\/|\/app\/|\.[jt]s:\d+|\b[A-Z]\w*Error\b|"stack")/;

interface Route {
  method: string;
  /** `:id` is replaced by the generated path segment. */
  path: string;
  body?: Obj;
  /** Body cap of the route's parser; bodies are generated up to just past it. */
  limit?: number;
  auth?: "admin" | "session";
  /** Cache-Control a 2xx must carry (docs/PROTOCOL.md 4.1, 4.2, 4.4; SECURITY.md for evidence). */
  okCache?: string;
  /** A 2xx body that is not JSON. */
  okType?: string;
  /** 5xx statuses the docs promise for this route. */
  allowed5xx?: number[];
}

const BILLING_5XX = [502, 503];
const ADMIN_5XX = [503];
const ROUTES: Route[] = [
  { method: "GET", path: "/healthz", okCache: "no-store" },
  { method: "GET", path: "/health", okCache: "no-store" },
  { method: "GET", path: "/readyz", okCache: "no-store", allowed5xx: [503] },
  { method: "GET", path: "/metrics", okCache: "no-store", okType: "text/plain" },
  { method: "GET", path: "/api/config", okCache: "public, max-age=30" },
  {
    method: "POST",
    path: "/api/session",
    limit: SESSION_BODY_LIMIT_BYTES,
    allowed5xx: [503],
    body: obj({
      deviceId: new Ref("uuid"),
      fingerprint: "a".repeat(64),
      age: obj({ dob: "1990-01-01", attest18: true, tosVersion: TOS_VERSION }),
    }),
  },
  { method: "GET", path: "/api/restrictions/:id" },
  {
    method: "POST",
    path: "/api/appeals",
    limit: ENFORCEMENT_BODY_LIMIT_BYTES,
    body: obj({ restrictionId: new Ref("uuid"), deviceId: new Ref("uuid"), text: "Please look at this again." }),
  },
  {
    method: "POST",
    path: "/api/takedowns",
    limit: ENFORCEMENT_BODY_LIMIT_BYTES,
    body: obj({
      kind: "ncii",
      contactEmail: "person@example.com",
      description: "A frame of me was captured in a report.",
      isAffectedPerson: true,
      goodFaithStatement: true,
    }),
  },
  { method: "GET", path: "/api/billing/packs", okCache: "public, max-age=30", allowed5xx: BILLING_5XX },
  { method: "GET", path: "/api/billing/wallet", auth: "session", allowed5xx: BILLING_5XX },
  { method: "POST", path: "/api/billing/orders", auth: "session", limit: BILLING_BODY_LIMIT_BYTES, allowed5xx: BILLING_5XX, body: obj({ packId: "week" }) },
  {
    method: "POST",
    path: "/api/billing/verify",
    auth: "session",
    limit: BILLING_BODY_LIMIT_BYTES,
    allowed5xx: BILLING_5XX,
    body: obj({ orderId: new Ref("orderId"), paymentId: "pay_fuzz", signature: FAKE_SIGNATURE }),
  },
  { method: "POST", path: "/api/billing/unlock", auth: "session", limit: BILLING_BODY_LIMIT_BYTES, allowed5xx: BILLING_5XX, body: obj({ feature: "gender_filter", days: 1 }) },
  {
    method: "POST",
    path: "/api/billing/webhook",
    limit: WEBHOOK_BODY_LIMIT_BYTES,
    allowed5xx: BILLING_5XX,
    body: obj({
      event: "payment.captured",
      payload: obj({ payment: obj({ entity: obj({ id: "pay_hook", order_id: new Ref("orderId"), amount: 9_900, currency: "INR" }) }) }),
    }),
  },
  { method: "GET", path: "/admin/api/queue", auth: "admin", allowed5xx: ADMIN_5XX },
  { method: "GET", path: "/admin/api/reports/:id", auth: "admin", allowed5xx: ADMIN_5XX },
  { method: "GET", path: "/admin/api/reports/:id/evidence", auth: "admin", allowed5xx: ADMIN_5XX, okCache: "no-store", okType: "image/jpeg" },
  {
    method: "POST",
    path: "/admin/api/reports/:id/action",
    auth: "admin",
    limit: ADMIN_BODY_LIMIT_BYTES,
    allowed5xx: ADMIN_5XX,
    body: obj({ action: "restrict", reason: "spam", durationMs: 600_000, note: "fuzz" }),
  },
  { method: "POST", path: "/admin/api/reports/:id/escalate", auth: "admin", limit: ADMIN_BODY_LIMIT_BYTES, allowed5xx: ADMIN_5XX, body: obj({ note: "fuzz" }) },
  { method: "GET", path: "/admin/api/appeals", auth: "admin", allowed5xx: ADMIN_5XX },
  { method: "POST", path: "/admin/api/appeals/:id/decision", auth: "admin", limit: ADMIN_BODY_LIMIT_BYTES, allowed5xx: ADMIN_5XX, body: obj({ decision: "uphold" }) },
  { method: "GET", path: "/admin/api/takedowns", auth: "admin", allowed5xx: ADMIN_5XX },
  { method: "POST", path: "/admin/api/takedowns/:id/resolve", auth: "admin", limit: ADMIN_BODY_LIMIT_BYTES, allowed5xx: ADMIN_5XX, body: obj({ resolution: "done" }) },
  { method: "GET", path: "/admin/api/flags", auth: "admin", allowed5xx: ADMIN_5XX },
  { method: "PUT", path: "/admin/api/flags", auth: "admin", limit: ADMIN_BODY_LIMIT_BYTES, allowed5xx: ADMIN_5XX, body: obj({ banner_message: "fuzz" }) },
  { method: "GET", path: "/admin/api/audit", auth: "admin", allowed5xx: ADMIN_5XX },
  { method: "GET", path: "/admin/api/wallets/:id", auth: "admin", allowed5xx: ADMIN_5XX },
  { method: "POST", path: "/admin/api/wallets/:id/adjust", auth: "admin", limit: ADMIN_BODY_LIMIT_BYTES, allowed5xx: ADMIN_5XX, body: obj({ delta: 5, note: "fuzz" }) },
  { method: "GET", path: "/admin/api/billing/orders", auth: "admin", allowed5xx: ADMIN_5XX },
];

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"];
const CONTENT_TYPES = [
  "application/json",
  "application/json; charset=utf-8",
  "application/json; charset=UTF-16",
  "application/json; charset=latin1",
  "application/json; charset=nope",
  "application/json;;;",
  "APPLICATION/JSON",
  "application/vnd.api+json",
  "text/plain",
  "text/json",
  "application/x-www-form-urlencoded",
  "multipart/form-data; boundary=x",
  "application/octet-stream",
  "*/*",
  "",
];
const QUERY_KEYS = ["status", "limit", "before", "deviceId", "__proto__", "constructor", "toString", "a[b]", "a[]", "", "x"];

/** Bytes as a client may put them in a path or query: percent-encoded, or broken encodings on purpose. */
const urlPart: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: shortString.map((s) => encodeURIComponent(s.replace(/[\ud800-\udfff]/g, "?"))) },
  { weight: 1, arbitrary: fc.constantFrom("%", "%E0%A4%A", "%ZZ", "%00", "..%2F..", "%2e%2e", "%c0%af", "%uD800", "%ff%fe", "a%20b") },
  { weight: 1, arbitrary: fc.uuid() },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 6_000 }).map((n) => "a".repeat(n)) },
);

/** Header values: printable ASCII only (anything else is a 400 from Node's parser before the app runs). */
const headerValue: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: "binary-ascii", maxLength: 40 }).map((s) => s.replace(/[^\x20-\x7e]/g, "").trim()),
  fc.constantFrom("Bearer", "Bearer ", "Basic YTpi", "Bearer null", "Bearer undefined", `Bearer ${"x".repeat(5_000)}`),
);

interface Req {
  route: Route;
  method: string;
  id: string;
  query: [string, string][];
  contentType: string | null;
  extraHeaders: [string, string][];
  auth: "valid" | "none" | "garbage" | "duplicated";
  authValue: string;
  contentEncoding: string | null;
  body: { kind: "none" } | { kind: "json"; value: Fuzz } | { kind: "text"; text: string } | { kind: "lie" };
  signature: "valid" | "none" | "garbage" | "duplicated";
  ip: string;
  /** Which of the pooled session tokens a billing request carries (POST /orders allows 5 per device per 5 minutes). */
  session: number;
}

function bodyArb(route: Route): fc.Arbitrary<Req["body"]> {
  const limit = route.limit ?? 16 * 1024;
  const field = fc.oneof({ weight: 6, arbitrary: leaf(["uuid", "orderId"]) }, { weight: 3, arbitrary: tree(["uuid", "orderId"]) }, { weight: 1, arbitrary: hugeString(100, limit + 512) });
  const json: fc.Arbitrary<Fuzz>[] = [tree(["uuid", "orderId"]), deepNesting(Math.floor(limit / 2) + 64)];
  if (route.body) json.push(mutated(route.body, field), mutated(route.body, field), extended(route.body, field), fc.constant(route.body));
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant({ kind: "none" as const }) },
    { weight: 10, arbitrary: fc.oneof(...json).map((value) => ({ kind: "json" as const, value })) },
    { weight: 2, arbitrary: fc.oneof(shortString, fc.constantFrom(...EDGE_STRINGS, "{", "[1,", '{"a":1}garbage', "null", '"str"', "1e400", "{\"__proto__\":{\"x\":1}}"), hugeString(100, limit + 512)).map((text) => ({ kind: "text" as const, text })) },
    { weight: 1, arbitrary: fc.constant({ kind: "lie" as const }) },
  );
}

/** Mostly the JSON a client sends, so requests get past the parser; the rest probe its edges. */
const contentType = fc.oneof(
  { weight: 6, arbitrary: fc.constant<string | null>("application/json") },
  { weight: 3, arbitrary: fc.constantFrom<string | null>(...CONTENT_TYPES) },
  { weight: 1, arbitrary: fc.constant(null) },
);

const extraHeader = fc.tuple(
  fc.oneof(
    { weight: 10, arbitrary: fc.constantFrom("content-type", "origin", "x-real-ip", "accept", "accept-encoding", "x-razorpay-signature", "cookie") },
    { weight: 1, arbitrary: fc.constant("expect") },
  ),
  fc.oneof(fc.constantFrom(...CONTENT_TYPES, "100-continue"), headerValue),
);

const reqArb: fc.Arbitrary<Req> = fc.constantFrom(...ROUTES).chain((route) =>
  fc.record({
    route: fc.constant(route),
    method: fc.oneof({ weight: 4, arbitrary: fc.constant(route.method) }, { weight: 1, arbitrary: fc.constantFrom(...METHODS) }),
    id: fc.oneof({ weight: 1, arbitrary: fc.uuid() }, { weight: 1, arbitrary: urlPart }),
    query: fc.array(fc.tuple(fc.oneof(fc.constantFrom(...QUERY_KEYS), urlPart), urlPart), { maxLength: 4 }),
    contentType,
    extraHeaders: fc.array(extraHeader, { maxLength: 3 }),
    auth: fc.constantFrom("valid", "valid", "valid", "none", "garbage", "duplicated"),
    authValue: headerValue,
    contentEncoding: fc.option(fc.constantFrom("gzip", "br", "deflate", "identity", "gzip, identity"), { nil: null, freq: 10 }),
    body: bodyArb(route),
    signature: fc.constantFrom("valid", "none", "garbage", "duplicated"),
    ip: fc.ipV4(),
    session: fc.nat({ max: SESSIONS - 1 }),
  }),
);

interface Res {
  status: number;
  headers: Record<string, string[]>;
  body: string;
  ms: number;
}

let ts: TestServer;
let ctx: Record<string, string>;
const sessionTokens: string[] = [];
const logLines: string[] = [];

/**
 * One request on its own connection (Connection: close); resolves with the
 * whole response once the server closes. The write side stays open: a client
 * FIN before the answer is a different request (an abort).
 */
function send(head: string, body: string): Promise<Res> {
  const { hostname, port } = new URL(ts.url);
  const started = performance.now();
  const { promise, resolve, reject } = Promise.withResolvers<Res>();
  const decoder = new TextDecoder();
  let received = "";
  const socket = connect(Number(port), hostname, () => {
    socket.write(head, "latin1");
    socket.write(body, "utf8");
  });
  // The server may close while this side is still writing (a refused Content-Length): keep what it answered.
  socket.on("error", () => {});
  socket.on("data", (chunk: Uint8Array) => (received += decoder.decode(chunk, { stream: true })));
  // A server that never closes is a failure to report, not a test that hangs.
  const hang = setTimeout(() => {
    socket.destroy();
    reject(new Error(`no close after ${HANG_MS} ms; received ${JSON.stringify(received.slice(0, 300))}`));
  }, HANG_MS);
  socket.on("close", () => {
    clearTimeout(hang);
    // Skip interim answers (100 Continue for `Expect: 100-continue`).
    const raw = (received + decoder.decode()).replace(/^(HTTP\/1\.1 1\d\d [^\r]*\r\n\r\n)+/, "");
    const split = raw.indexOf("\r\n\r\n");
    if (split < 0) return reject(new Error(`no response head: ${JSON.stringify(raw.slice(0, 200))}`));
    const [statusLine, ...lines] = raw.slice(0, split).split("\r\n");
    const headers: Record<string, string[]> = {};
    for (const line of lines) {
      const at = line.indexOf(":");
      (headers[line.slice(0, at).trim().toLowerCase()] ??= []).push(line.slice(at + 1).trim());
    }
    let text = raw.slice(split + 4);
    if (headers["transfer-encoding"]?.includes("chunked")) {
      let out = "";
      for (let rest = text; ; ) {
        const eol = rest.indexOf("\r\n");
        const size = parseInt(rest.slice(0, eol), 16);
        if (!size) break;
        out += rest.slice(eol + 2, eol + 2 + size);
        rest = rest.slice(eol + 2 + size + 2);
      }
      text = out;
    }
    resolve({ status: Number(statusLine!.split(" ")[1]), headers, body: text, ms: performance.now() - started });
  });
  return promise;
}

function build(r: Req): { head: string; body: string; describe: string } {
  const path = r.route.path.replace(":id", r.id);
  const query = r.query.map(([k, v]) => `${k}=${v}`).join("&");
  const target = query ? `${path}?${query}` : path;
  const body =
    r.body.kind === "json" ? toJsonText(r.body.value, { ...ctx, uuid: randomUUID() }) : r.body.kind === "text" ? r.body.text : "";
  const headers: [string, string][] = [
    ["Host", new URL(ts.url).host],
    ["Connection", "close"],
    ["X-Real-IP", r.ip],
  ];
  if (r.contentType !== null) headers.push(["Content-Type", r.contentType]);
  const token = r.route.auth === "admin" ? ADMIN : r.route.auth === "session" ? sessionTokens[r.session]! : null;
  if (token && r.auth !== "none") {
    headers.push(["Authorization", r.auth === "garbage" ? r.authValue : `Bearer ${token}`]);
    if (r.auth === "duplicated") headers.push(["Authorization", r.authValue]);
  }
  if (r.contentEncoding) headers.push(["Content-Encoding", r.contentEncoding]);
  if (r.route.path.endsWith("/webhook") && r.signature !== "none") {
    headers.push(["X-Razorpay-Signature", r.signature === "garbage" ? r.authValue : webhookSignature(WEBHOOK_SECRET, body)]);
    if (r.signature === "duplicated") headers.push(["X-Razorpay-Signature", webhookSignature(WEBHOOK_SECRET, body)]);
  }
  headers.push(...r.extraHeaders);
  // A declared body far over every cap, never sent: the guard must refuse it from the header alone.
  headers.push(["Content-Length", String(r.body.kind === "lie" ? 50 * 1024 * 1024 : Buffer.byteLength(body))]);
  const head = `${r.method} ${target} HTTP/1.1\r\n${headers.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  const shown = body.length > 200 ? `${body.slice(0, 200)}... (${Buffer.byteLength(body)} bytes)` : body;
  return { head, body, describe: `${head}${shown}` };
}

/** Request heads above this may meet the runtime's header size limit (Node's default is 16 KiB). */
const HEAD_LIMIT_BYTES = 8 * 1024;

function check(r: Req, res: Res, head: string, describe: string): void {
  const fail = (why: string) => {
    throw new Error(`${why}\n--- request\n${describe}\n--- response ${res.status} ${JSON.stringify(res.headers)}\n${res.body.slice(0, 500)}`);
  };
  if (res.ms > RESPONSE_BUDGET_MS) fail(`answered after ${Math.round(res.ms)} ms`);
  if (res.status >= 500 && !(r.route.allowed5xx ?? []).includes(res.status)) fail(`undocumented ${res.status}`);
  if (LEAK.test(res.body)) fail("internal detail in the body");
  const ok = res.status >= 200 && res.status < 300;
  const cache = res.headers["cache-control"]?.join(", ");
  if (ok && r.route.okCache && r.method === r.route.method && cache !== r.route.okCache) fail(`Cache-Control ${String(cache)}, documented ${r.route.okCache}`);
  if (!ok && cache?.includes("public")) fail("an error response is publicly cacheable");
  // Answers the HTTP layer gives before the app runs, each only for the request that provokes it:
  // an Expect other than 100-continue (417, RFC 9110 10.1.1) and an oversized request head (431).
  const runtime =
    (res.status === 417 && r.extraHeaders.some(([name]) => name === "expect")) || (res.status === 431 && head.length > HEAD_LIMIT_BYTES);
  // An OPTIONS that is not a preflight from an allowed origin gets Express's own answer: 200 with the
  // Allow list as the body (RFC 9110 9.3.7); nothing else may answer outside JSON.
  const allowList = r.method === "OPTIONS" && res.status === 200 && res.headers.allow?.[0] === res.body;
  if (r.method === "HEAD" || res.status === 204 || runtime || allowList) return;
  const type = res.headers["content-type"]?.[0] ?? "";
  if (ok && r.route.okType && r.method === r.route.method) {
    if (!type.startsWith(r.route.okType)) fail(`Content-Type ${type}, expected ${r.route.okType}`);
    return;
  }
  if (!type.startsWith("application/json")) fail(`Content-Type ${type || "(none)"}, expected JSON`);
  try {
    JSON.parse(res.body);
  } catch {
    fail("body is not JSON");
  }
}

beforeAll(async () => {
  const logger = pino({ level: "warn" }, { write: (line: string) => void logLines.push(line) });
  ts = await startServer(
    { requireSession: true, razorpayFake: true, razorpayWebhookSecret: WEBHOOK_SECRET, adminToken: ADMIN, proxyIpHeader: "x-real-ip" },
    undefined,
    { logger },
  );
  for (let i = 0; i < SESSIONS; i++) {
    const session = await postSession(ts, sessionBody());
    if (!session.body.ok) throw new Error(`session refused: ${session.body.error}`);
    sessionTokens.push(session.body.sessionToken);
  }
  const order = await fetch(`${ts.url}/api/billing/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sessionTokens[0]}` },
    body: JSON.stringify({ packId: "week" }),
  });
  const { orderId } = (await order.json()) as { orderId: string };
  ctx = { orderId };
});

afterAll(() => ts?.close());

describe("REST routes under arbitrary requests", () => {
  test(
    "no undocumented 5xx, JSON without internals, documented Cache-Control, bounded time",
    async () => {
      await fc.assert(
        fc.asyncProperty(reqArb, async (r) => {
          const { head, body, describe } = build(r);
          check(r, await send(head, body), head, describe);
        }),
        { seed: SEED, numRuns: 1_000, endOnFailure: true },
      );
      const errors = logLines.map((l) => JSON.parse(l) as { level: number; event?: string }).filter((l) => l.level >= 50);
      // The one documented error-level line: the operator alert when the run's bad admin tokens spend the
      // instance-wide budget (docs/PROTOCOL.md 4.5, logged once per window). Anything else is a failure.
      const alerts = errors.filter((l) => l.event === "admin_auth_budget_exhausted");
      expect(alerts.length).toBeLessThanOrEqual(1);
      expect(errors.filter((l) => l.event !== "admin_auth_budget_exhausted")).toEqual([]);
      const health = await fetch(`${ts.url}/healthz`);
      expect(health.status).toBe(200);
      // From an address the run never used: requests with a refused IP header share the "unknown" buckets.
      expect((await postSession(ts, sessionBody(), { "x-real-ip": "198.51.100.7" })).status).toBe(200);
    },
    120_000,
  );
});
