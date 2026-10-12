/**
 * Shared test helpers: a fast config, a real server on port 0 and typed
 * socket.io clients with small await helpers.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Redis from "ioredis";
import { io as ioClient, type Socket } from "socket.io-client";
import { loadConfig, type Config } from "../src/config";
import { RedisEnforcementStore } from "../src/enforcement/RedisEnforcementStore";
import { createLogger } from "../src/logger";
import {
  PROTOCOL_VERSION,
  TOS_VERSION,
  type ClientToServerEvents,
  type SessionRequest,
  type SessionResponse,
  type HelloAck,
  type HelloPayload,
  type Preferences,
  type Profile,
  type ServerToClientEvents,
} from "../src/protocol";
import { createServer, type ChizzyServer, type ServerDeps } from "../src/server";
import { connectRedisAdapter } from "../src/realtime/redisAdapter";
import { MemoryStore } from "../src/store/MemoryStore";
import { RedisStore } from "../src/store/RedisStore";
import type { MatchStore } from "../src/store/MatchStore";

export type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Matchmaking timings shrunk so integration tests run in milliseconds.
 * The session gate is OFF here so matchmaking tests can connect directly;
 * gate tests pass `requireSession: true` and use createSession().
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", MAX_CONNECTIONS_PER_IP: "1000" }),
    requireSession: false,
    // Tests open many sockets from one address in quick succession.
    connectRatePerIp: { capacity: 1_000_000, refillPerSec: 1_000_000 },
    sessionRateTotal: { capacity: 1_000_000, refillPerSec: 1_000_000 },
    // A busy test runner must not trip overload shedding; shedding tests inject a sampler.
    loadSampleIntervalMs: 0,
    matchAcceptTimeoutMs: 400,
    matchAcceptGraceMs: 50,
    sweepIntervalMs: 20,
    recheckIntervalMs: 40,
    coinIntervalMs: 150,
    friendAfterMs: 350,
    evidenceDir: join(tmpdir(), `chizzy-test-evidence-${process.pid}`),
    ...overrides,
  };
}

export function profile(overrides: Partial<Profile> = {}): Profile {
  return { name: "Tester", country: "IN", language: "en", gender: "unspecified", topics: ["general"], ...overrides };
}

export function prefs(overrides: Partial<Preferences> = {}): Preferences {
  return { genderFilter: "all", languageFilter: "any", ...overrides };
}

export function hello(overrides: Partial<HelloPayload> = {}): HelloPayload {
  return { protocolVersion: PROTOCOL_VERSION, deviceId: randomUUID(), profile: profile(), preferences: prefs(), mode: "preview", ...overrides };
}

export interface TestServer {
  server: ChizzyServer;
  store: MatchStore;
  config: Config;
  url: string;
  clients: Client[];
  connect(opts?: { headers?: Record<string, string>; auth?: Record<string, unknown> }): Promise<Client>;
  close(): Promise<void>;
}

/**
 * Boots a server on a random port. Without an explicit store it uses a
 * MemoryStore, or, when TEST_STORE=redis and REDIS_URL are set, a RedisStore
 * on a fresh key prefix plus the Redis adapter (so every integration test can
 * also run against Redis; both are closed with the server).
 */
export async function startServer(
  overrides: Partial<Config> = {},
  store?: MatchStore,
  deps: Pick<ServerDeps, "configureIo" | "fetch" | "restrictions" | "redis" | "flags" | "enforcement" | "billing" | "loadSampler"> = {},
): Promise<TestServer> {
  // Each server gets its own evidence directory, removed on close.
  const evidenceDir = mkdtempSync(join(tmpdir(), "chizzy-evidence-"));
  const config = testConfig({ evidenceDir, ...overrides });
  const owned: { close(): Promise<void> }[] = [{ close: async () => rmSync(evidenceDir, { recursive: true, force: true }) }];
  if (!store && process.env.TEST_STORE === "redis" && process.env.REDIS_URL) {
    const redisUrl = process.env.REDIS_URL;
    const redisStore = await RedisStore.connect(redisUrl, { prefix: `test:${randomUUID()}:` });
    const adapter = await connectRedisAdapter(redisUrl, createLogger("silent"), `test:${randomUUID()}:socket.io`);
    // The shared feature-store client, as index.ts creates it in Redis mode.
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
    owned.push(redisStore, adapter, { close: async () => void (await redis.quit()) });
    store = redisStore;
    deps = {
      configureIo: adapter.install,
      redis,
      ...deps,
      enforcement: { store: new RedisEnforcementStore(redis, `test:${randomUUID()}:enf:`), ...deps.enforcement },
    };
  }
  store ??= new MemoryStore();
  const server = createServer(config, { store, logger: createLogger("silent"), ...deps });
  const port = await server.listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];
  let closing: Promise<void> | undefined;
  return {
    server,
    store,
    config,
    url,
    clients,
    async connect(opts = {}) {
      const client: Client = ioClient(url, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
        extraHeaders: opts.headers,
        auth: opts.auth,
      });
      clients.push(client);
      await new Promise<void>((resolve, reject) => {
        client.once("connect", () => resolve());
        client.once("connect_error", (err) => reject(err));
      });
      return client;
    },
    // Idempotent: a test may close its server and the afterEach close it again,
    // and a second quit() on the shared Redis client would reject.
    close() {
      closing ??= (async () => {
        for (const c of clients) c.disconnect();
        await server.close();
        for (const o of owned) await o.close();
      })();
      return closing;
    },
  };
}

/** A valid POST /api/session body for a new adult device. */
export function sessionBody(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return {
    deviceId: randomUUID(),
    fingerprint: "a".repeat(64),
    turnstileToken: "test-token",
    age: { dob: "1990-01-01", attest18: true, tosVersion: TOS_VERSION },
    ...overrides,
  };
}

export async function postSession(
  ts: Pick<TestServer, "url">,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: SessionResponse }> {
  const res = await fetch(`${ts.url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as SessionResponse };
}

/** Creates a session for a new device and connects a client with its token. */
export async function connectWithSession(
  ts: TestServer,
  overrides: Partial<SessionRequest> = {},
): Promise<{ client: Client; deviceId: string; sessionToken: string }> {
  const body = sessionBody(overrides);
  const res = await postSession(ts, body);
  if (!res.body.ok) throw new Error(`session refused: ${res.body.error}`);
  const client = await ts.connect({ auth: { sessionToken: res.body.sessionToken } });
  return { client, deviceId: body.deviceId, sessionToken: res.body.sessionToken };
}

/** Resolves with the next payload of `event`, or rejects after `ms`. */
export function next<E extends keyof ServerToClientEvents>(
  client: Client,
  event: E,
  ms = 2000,
): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(event, handler as never);
      reject(new Error(`timed out waiting for ${event}`));
    }, ms);
    const handler = (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload as Parameters<ServerToClientEvents[E]>[0]);
    };
    client.once(event, handler as never);
  });
}

/** Resolves true if `event` arrives within `ms`, false otherwise. */
export function arrives(client: Client, event: keyof ServerToClientEvents, ms = 300): Promise<boolean> {
  return next(client, event, ms).then(
    () => true,
    () => false,
  );
}

/** Records every payload of `event` for later assertions. */
export function record<E extends keyof ServerToClientEvents>(
  client: Client,
  event: E,
): Parameters<ServerToClientEvents[E]>[0][] {
  const seen: Parameters<ServerToClientEvents[E]>[0][] = [];
  client.on(event, ((payload: Parameters<ServerToClientEvents[E]>[0]) => seen.push(payload)) as never);
  return seen;
}

export function sendHello(client: Client, payload: HelloPayload): Promise<HelloAck> {
  return client.timeout(2000).emitWithAck("session:hello", payload);
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens a raw WebSocket upgrade to the server and resolves with the HTTP
 * status line and body the server answered. A refused upgrade (per-IP cap,
 * connect rate, origin) is a 400 whose body names the reason; the Socket.IO
 * client only ever reports "websocket error" for it. On success the socket
 * is closed at once (the connection is counted and released server-side).
 */
export function rawUpgrade(ts: Pick<TestServer, "url">, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(ts.url);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) });
    let text = "";
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const status = Number(text.slice(9, 12));
      if (status === 101) {
        socket.destroy();
        resolve({ status, body: "" });
        return;
      }
      const split = text.indexOf("\r\n\r\n");
      if (split < 0) return;
      const length = Number(/content-length: (\d+)/i.exec(text)?.[1] ?? 0);
      const body = text.slice(split + 4);
      if (body.length < length) return;
      socket.destroy();
      resolve({ status, body });
    });
    const extra = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    socket.write(
      `GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n${extra}\r\n`,
    );
  });
}

/** Two clients that said hello and both received match:found. */
export async function matchedPair(
  ts: TestServer,
  a: HelloPayload = hello(),
  b: HelloPayload = hello(),
): Promise<{ ca: Client; cb: Client; roomId: string; a: HelloPayload; b: HelloPayload }> {
  const ca = await ts.connect();
  const cb = await ts.connect();
  const foundA = next(ca, "match:found");
  const foundB = next(cb, "match:found");
  await sendHello(ca, a);
  await sendHello(cb, b);
  const [fa, fb] = await Promise.all([foundA, foundB]);
  if (fa.roomId !== fb.roomId) throw new Error("clients matched into different rooms");
  return { ca, cb, roomId: fa.roomId, a, b };
}

/** A matched pair that both accepted; resolves after both got call:start. */
export async function activePair(ts: TestServer, a?: HelloPayload, b?: HelloPayload) {
  const pair = await matchedPair(ts, a, b);
  const startA = next(pair.ca, "call:start");
  const startB = next(pair.cb, "call:start");
  pair.ca.emit("match:accept", { roomId: pair.roomId });
  pair.cb.emit("match:accept", { roomId: pair.roomId });
  const [sa, sb] = await Promise.all([startA, startB]);
  return { ...pair, startA: sa, startB: sb };
}

/** An active pair whose peer connections both reported connected (rewards run from here). */
export async function connectedPair(ts: TestServer, a?: HelloPayload, b?: HelloPayload) {
  const pair = await activePair(ts, a, b);
  pair.ca.emit("call:connected", { roomId: pair.roomId });
  pair.cb.emit("call:connected", { roomId: pair.roomId });
  return pair;
}
