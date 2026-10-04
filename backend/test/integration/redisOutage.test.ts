/**
 * A Redis outage longer than the instance TTL lets every heartbeat expire.
 * Replicas then reconnect at different moments; the first one back must not
 * reap its live peers before they had a chance to beat again.
 *
 * Each server reaches Redis for its store through its own TCP proxy, so the
 * test can cut both off and bring them back one after the other.
 * Skipped unless REDIS_URL is set.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer as createTcpServer, connect as tcpConnect, type Server, type Socket } from "node:net";
import { createLogger } from "../../src/logger";
import { connectRedisAdapter } from "../../src/realtime/redisAdapter";
import { RedisStore } from "../../src/store/RedisStore";
import { type Client, hello, next, record, sendHello, startServer, type TestServer } from "../helpers";

const url = process.env.REDIS_URL;

const HEARTBEAT_MS = 200;
const TTL_MS = 1500;
const OUTAGE_MS = 2000;
/**
 * How much later B's proxy comes back than A's. ioredis retries with a
 * growing delay (about 500 ms apart at this point), so this keeps B's
 * reconnect on a later retry than A's while staying well inside one TTL.
 */
const B_DELAY_MS = 500;

/** TCP proxy to Redis that can drop every connection and refuse new ones. */
class RedisProxy {
  url = "";
  private readonly sockets = new Set<Socket>();
  private up = true;
  private readonly server: Server;

  private constructor(private readonly target: URL) {
    this.server = createTcpServer((client) => this.accept(client));
  }

  static async start(target: string): Promise<RedisProxy> {
    const proxy = new RedisProxy(new URL(target));
    await new Promise<void>((resolve) => proxy.server.listen(0, "127.0.0.1", resolve));
    const proxied = new URL(target);
    proxied.hostname = "127.0.0.1";
    proxied.port = String((proxy.server.address() as { port: number }).port);
    proxy.url = proxied.toString();
    return proxy;
  }

  private accept(client: Socket): void {
    if (!this.up) {
      client.destroy();
      return;
    }
    const upstream = tcpConnect(Number(this.target.port || 6379), this.target.hostname);
    for (const s of [client, upstream]) {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
      s.on("error", () => {});
    }
    client.pipe(upstream).pipe(client);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  }

  down(): void {
    this.up = false;
    for (const s of this.sockets) s.destroy();
  }

  restore(): void {
    this.up = true;
  }

  close(): Promise<void> {
    this.down();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

let cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
  cleanups = [];
}, 20_000); // a server still cut off from Redis needs a reconnect before it can shut down

/** One server whose store goes through its own proxy; the adapter talks to Redis directly. */
async function node(prefix: string, adapterKey: string) {
  const proxy = await RedisProxy.start(url!);
  const store = await RedisStore.connect(proxy.url, { prefix });
  const adapter = await connectRedisAdapter(url!, createLogger("silent"), adapterKey);
  const server = await startServer(
    { heartbeatIntervalMs: HEARTBEAT_MS, instanceTtlMs: TTL_MS },
    store,
    { configureIo: adapter.install },
  );
  cleanups.push(
    () => proxy.close(),
    () => adapter.close(),
    () => store.close(),
    () => server.close(),
    async () => proxy.restore(),
  );
  return { proxy, server };
}

async function crossInstanceCall(a: TestServer, b: TestServer) {
  const ca = await a.connect();
  const cb = await b.connect();
  const foundA = next(ca, "match:found");
  const foundB = next(cb, "match:found");
  await sendHello(ca, hello());
  await sendHello(cb, hello());
  const [fa] = await Promise.all([foundA, foundB]);
  const startA = next(ca, "call:start");
  const startB = next(cb, "call:start");
  ca.emit("match:accept", { roomId: fa.roomId });
  cb.emit("match:accept", { roomId: fa.roomId });
  await Promise.all([startA, startB]);
  return { ca, cb, roomId: fa.roomId };
}

function watch(client: Client) {
  return { ended: record(client, "match:ended"), shutdown: record(client, "server:shutdown") };
}

describe.skipIf(!url)("Redis outage longer than the instance TTL", () => {
  test(
    "the replica that reconnects first does not reap a live peer that reconnects later",
    async () => {
      const prefix = `test:${randomUUID()}:`;
      const adapterKey = `test:${randomUUID()}:socket.io`;
      const a = await node(prefix, adapterKey);
      const b = await node(prefix, adapterKey);
      const { ca, cb } = await crossInstanceCall(a.server, b.server);
      const seenA = watch(ca);
      const seenB = watch(cb);

      a.proxy.down();
      b.proxy.down();
      await Bun.sleep(OUTAGE_MS); // every heartbeat key has expired by now
      a.proxy.restore();
      await Bun.sleep(B_DELAY_MS); // A is back well before B
      b.proxy.restore();
      await Bun.sleep(TTL_MS * 2);

      expect(seenA).toEqual({ ended: [], shutdown: [] });
      expect(seenB).toEqual({ ended: [], shutdown: [] });
      const store = a.server.store;
      const [sessions, dead] = await store.withLock(() =>
        Promise.all([store.getSessions([ca.id!, cb.id!]), store.listDeadInstances()]),
      );
      expect(sessions.map((s) => s?.state)).toEqual(["active", "active"]);
      expect(dead).toEqual([]);
    },
    15_000,
  );

  test(
    "a peer that never comes back is still reaped, one TTL after recovery",
    async () => {
      const prefix = `test:${randomUUID()}:`;
      const adapterKey = `test:${randomUUID()}:socket.io`;
      const a = await node(prefix, adapterKey);
      const b = await node(prefix, adapterKey);
      const { ca, cb, roomId } = await crossInstanceCall(a.server, b.server);

      a.proxy.down();
      b.proxy.down();
      await Bun.sleep(OUTAGE_MS);
      const restoredAt = Date.now();
      const ended = next(ca, "match:ended", TTL_MS * 4);
      a.proxy.restore(); // B stays cut off from Redis

      expect(await ended).toEqual({ roomId, reason: "partner-unavailable" });
      // Reaping waits a full TTL after A's first successful heartbeat.
      expect(Date.now() - restoredAt).toBeGreaterThanOrEqual(TTL_MS);
      const store = a.server.store;
      expect(await store.withLock(() => store.getSession(cb.id!))).toBeNull();
    },
    15_000,
  );
});
