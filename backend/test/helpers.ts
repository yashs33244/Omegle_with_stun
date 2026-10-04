/**
 * Shared test helpers: a fast config, a real server on port 0 and typed
 * socket.io clients with small await helpers.
 */
import { randomUUID } from "node:crypto";
import { io as ioClient, type Socket } from "socket.io-client";
import { loadConfig, type Config } from "../src/config";
import { createLogger } from "../src/logger";
import {
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type HelloAck,
  type HelloPayload,
  type Preferences,
  type Profile,
  type ServerToClientEvents,
} from "../src/protocol";
import { createServer, type ChizzyServer, type ServerDeps } from "../src/server";
import { MemoryStore } from "../src/store/MemoryStore";
import type { MatchStore } from "../src/store/MatchStore";

export type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Matchmaking timings shrunk so integration tests run in milliseconds. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", MAX_CONNECTIONS_PER_IP: "1000" }),
    matchAcceptTimeoutMs: 400,
    matchAcceptGraceMs: 50,
    sweepIntervalMs: 20,
    fullMatchPassIntervalMs: 40,
    coinIntervalMs: 150,
    friendAfterMs: 350,
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
  return { protocolVersion: PROTOCOL_VERSION, deviceId: randomUUID(), profile: profile(), preferences: prefs(), ...overrides };
}

export interface TestServer {
  server: ChizzyServer;
  store: MatchStore;
  config: Config;
  url: string;
  clients: Client[];
  connect(opts?: { headers?: Record<string, string> }): Promise<Client>;
  close(): Promise<void>;
}

export async function startServer(
  overrides: Partial<Config> = {},
  store: MatchStore = new MemoryStore(),
  deps: Pick<ServerDeps, "configureIo"> = {},
): Promise<TestServer> {
  const config = testConfig(overrides);
  const server = createServer(config, { store, logger: createLogger("silent"), ...deps });
  const port = await server.listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];
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
      });
      clients.push(client);
      await new Promise<void>((resolve, reject) => {
        client.once("connect", () => resolve());
        client.once("connect_error", (err) => reject(err));
      });
      return client;
    },
    async close() {
      for (const c of clients) c.disconnect();
      await server.close();
    },
  };
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
