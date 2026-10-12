/**
 * HTTP surface hardening: request deadlines, body caps that answer before the
 * body is read, /metrics closed without a token in production, one store ping
 * per burst of /readyz, and the bound on Turnstile calls in flight.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import {
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_MAX_HEADERS_COUNT,
  HTTP_MAX_REQUESTS_PER_SOCKET,
  HTTP_REQUEST_TIMEOUT_MS,
  SESSION_BODY_LIMIT_BYTES,
  SESSION_BURST_FACTOR,
} from "../../src/http/constants";
import { TURNSTILE_MAX_INFLIGHT } from "../../src/session/constants";
import { MemoryStore } from "../../src/store/MemoryStore";
import type { FetchFn } from "../../src/turn/cloudflare";
import { delay, postSession, sessionBody, startServer, type TestServer } from "../helpers";

let ts: TestServer;
afterEach(async () => {
  await ts?.close();
});

/** Writes `head` on a fresh TCP connection and resolves with what the server sent before closing. */
function rawRequest(url: string, head: string, waitMs: number): Promise<{ response: string; closed: boolean; ms: number }> {
  const { hostname, port } = new URL(url);
  const { promise, resolve } = Promise.withResolvers<{ response: string; closed: boolean; ms: number }>();
  const started = Date.now();
  let response = "";
  const socket = connect(Number(port), hostname, () => socket.write(head));
  socket.on("data", (chunk) => (response += chunk.toString()));
  socket.on("close", () => resolve({ response, closed: true, ms: Date.now() - started }));
  // Guard for the failure mode under test (a server that never answers); the pass path resolves on close.
  setTimeout(() => {
    if (socket.destroyed) return;
    socket.destroy();
    resolve({ response, closed: false, ms: Date.now() - started });
  }, waitMs).unref();
  return promise;
}

/** Fake Siteverify: holds the first `count` calls until release(), answers later ones at once. */
function siteverifyGate(count: number) {
  const reached = Promise.withResolvers<void>();
  const held: ((v: Response) => void)[] = [];
  let answer: (() => Response) | undefined;
  let total = 0;
  return {
    reached: reached.promise,
    calls: () => total,
    call(): Promise<Response> {
      total++;
      if (answer) return Promise.resolve(answer());
      const call = Promise.withResolvers<Response>();
      held.push(call.resolve);
      if (held.length === count) reached.resolve();
      return call.promise;
    },
    release(make: () => Response) {
      answer = make;
      for (const resolve of held) resolve(make());
    },
  };
}

describe("request deadlines", () => {
  test("the http server runs with bounded header, request and keep-alive timeouts", async () => {
    ts = await startServer();
    const { httpServer } = ts.server;
    expect(httpServer.headersTimeout).toBe(HTTP_HEADERS_TIMEOUT_MS);
    expect(httpServer.requestTimeout).toBe(HTTP_REQUEST_TIMEOUT_MS);
    expect(httpServer.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
    expect(httpServer.maxHeadersCount).toBe(HTTP_MAX_HEADERS_COUNT);
    expect(httpServer.maxRequestsPerSocket).toBe(HTTP_MAX_REQUESTS_PER_SOCKET);
    // Node applies headersTimeout only when it is below requestTimeout.
    expect(HTTP_HEADERS_TIMEOUT_MS).toBeLessThan(HTTP_REQUEST_TIMEOUT_MS);
  });

  test("a Content-Length over the cap is refused before the body is read and the connection closed", async () => {
    ts = await startServer();
    // body-parser alone would drain the declared 5 MB (or wait for the request
    // timeout) before answering; nothing is sent here, so a drain never ends.
    const head = `POST /api/session HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${5_000_000}\r\n\r\n{}`;
    const { response, closed, ms } = await rawRequest(ts.url, head, 3_000);
    expect(response).toStartWith("HTTP/1.1 413 ");
    expect(response).toContain("\r\nConnection: close\r\n");
    expect(response.endsWith('{"ok":false,"error":"invalid"}')).toBe(true);
    expect(closed).toBe(true);
    expect(ms).toBeLessThan(2_000);
  });

  test("a body at the cap still parses; compressed bodies are refused without inflating them", async () => {
    ts = await startServer();
    const padded = { ...sessionBody(), pad: "x".repeat(SESSION_BODY_LIMIT_BYTES - 400) };
    expect(JSON.stringify(padded).length).toBeLessThanOrEqual(SESSION_BODY_LIMIT_BYTES);
    expect((await postSession(ts, padded)).status).toBe(200);
    const gz = await fetch(`${ts.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: Bun.gzipSync(JSON.stringify(sessionBody())),
    });
    expect(gz.status).toBe(415);
    expect(await gz.json()).toEqual({ ok: false, error: "invalid" });
  });

  test("a flood on /api/session is refused by the per-instance burst cap before the body is parsed", async () => {
    // Store limit 1/min: the burst bucket holds SESSION_BURST_FACTOR x 1 = 2 requests.
    ts = await startServer({ sessionRatePerIpPerMin: 1 });
    const head = `POST /api/session HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${5_000_000}\r\n\r\n`;
    // Over-cap bodies are refused by the parser, so they never reach the store limiter.
    for (let i = 0; i < SESSION_BURST_FACTOR; i++) expect((await rawRequest(ts.url, head, 3_000)).response).toStartWith("HTTP/1.1 413 ");
    const refused = await rawRequest(ts.url, head, 3_000);
    expect(refused.response).toStartWith("HTTP/1.1 429 ");
    expect(refused.response.endsWith('{"ok":false,"error":"rate_limited"}')).toBe(true);
    const text = await (await fetch(`${ts.url}/metrics`)).text();
    expect(text).toContain('chizzy_session_requests_total{result="rate_limited"} 1');
  });
});

describe("cheap and closed endpoints", () => {
  test("in production /metrics is 404 without METRICS_TOKEN, 401/200 with it", async () => {
    ts = await startServer({ nodeEnv: "production" });
    const closed = await fetch(`${ts.url}/metrics`, { headers: { Authorization: "Bearer anything" } });
    expect(closed.status).toBe(404);
    await ts.close();
    ts = await startServer({ nodeEnv: "production", metricsToken: "t0ken" });
    expect((await fetch(`${ts.url}/metrics`)).status).toBe(401);
    const ok = await fetch(`${ts.url}/metrics`, { headers: { Authorization: "Bearer t0ken" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  test("a burst of /readyz shares one store ping", async () => {
    const store = new MemoryStore();
    let pings = 0;
    const release = Promise.withResolvers<void>();
    store.ping = async () => {
      pings++;
      await release.promise;
    };
    ts = await startServer({}, store);
    pings = 0;
    const burst = Promise.all(Array.from({ length: 25 }, () => fetch(`${ts.url}/readyz`).then((r) => r.status)));
    // Real sockets: give every request of the burst time to reach the handler
    // while the first ping is still pending, then let that one ping answer.
    await delay(150);
    release.resolve();
    expect(await burst).toEqual(Array(25).fill(200));
    expect(pings).toBe(1);
    // The next request after the burst pings again (no stale cache).
    expect((await fetch(`${ts.url}/readyz`)).status).toBe(200);
    expect(pings).toBe(2);
  });

  test("Siteverify calls in flight are capped; the overflow answers 503 without a request", async () => {
    const siteverify = siteverifyGate(TURNSTILE_MAX_INFLIGHT);
    const fetchFn: FetchFn = (_url, init) => {
      if (!(init?.body instanceof URLSearchParams)) throw new Error("unexpected fetch");
      return siteverify.call();
    };
    ts = await startServer(
      {
        requireSession: true,
        turnstileSecret: "1x0000000000000000000000000000000AA",
        turnstileSiteKey: "1x00000000000000000000AA",
        sessionRatePerIpPerMin: 10_000,
        sessionRatePerNetworkPerMin: 10_000,
        sessionNewDevicesPerNetworkPerDay: 10_000,
      },
      undefined,
      { fetch: fetchFn },
    );
    const inflight = Array.from({ length: TURNSTILE_MAX_INFLIGHT }, () => postSession(ts, sessionBody()));
    await siteverify.reached;
    const overflow = await postSession(ts, sessionBody());
    expect(overflow).toEqual({ status: 503, body: { ok: false, error: "closed" } });
    expect(siteverify.calls()).toBe(TURNSTILE_MAX_INFLIGHT);
    siteverify.release(() => Response.json({ success: true }));
    for (const r of await Promise.all(inflight)) expect(r.status).toBe(200);
    // Slots are released once the calls finish: the next request is verified, not refused.
    expect((await postSession(ts, sessionBody())).status).toBe(200);
    expect(siteverify.calls()).toBe(TURNSTILE_MAX_INFLIGHT + 1);
  });
});
