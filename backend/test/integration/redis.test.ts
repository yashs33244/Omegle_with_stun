/**
 * Scale-out: several servers sharing one Redis, each with its own store
 * client and Socket.IO adapter, exactly like separate replicas.
 * Skipped unless REDIS_URL is set.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Redis from "ioredis";
import { io as ioClient } from "socket.io-client";
import type { Config } from "../../src/config";
import { createLogger } from "../../src/logger";
import { connectRedisAdapter } from "../../src/realtime/redisAdapter";
import { RedisStore } from "../../src/store/RedisStore";
import { type Client, hello, next, record, sendHello, startServer, type TestServer } from "../helpers";

const url = process.env.REDIS_URL;

interface Cluster {
  prefix: string;
  adapterKey: string;
  nodes: TestServer[];
  add(overrides?: Partial<Config>): Promise<TestServer>;
}

let cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
  cleanups = [];
});

function cluster(): Cluster {
  const c: Cluster = {
    prefix: `test:${randomUUID()}:`,
    adapterKey: `test:${randomUUID()}:socket.io`,
    nodes: [],
    async add(overrides = {}) {
      const store = await RedisStore.connect(url!, { prefix: c.prefix });
      const adapter = await connectRedisAdapter(url!, createLogger("silent"), c.adapterKey);
      const node = await startServer(overrides, store, { configureIo: adapter.install });
      cleanups.push(() => adapter.close(), () => store.close(), () => node.close());
      c.nodes.push(node);
      return node;
    },
  };
  return c;
}

/** One client on each instance, matched and both accepted. */
async function crossInstanceCall(a: TestServer, b: TestServer) {
  const ca = await a.connect();
  const cb = await b.connect();
  const foundA = next(ca, "match:found");
  const foundB = next(cb, "match:found");
  expect(await sendHello(ca, hello())).toMatchObject({ ok: true });
  expect(await sendHello(cb, hello())).toMatchObject({ ok: true });
  const [fa, fb] = await Promise.all([foundA, foundB]);
  expect(fa.roomId).toBe(fb.roomId);
  const startA = next(ca, "call:start");
  const startB = next(cb, "call:start");
  ca.emit("match:accept", { roomId: fa.roomId });
  cb.emit("match:accept", { roomId: fa.roomId });
  const [sa, sb] = await Promise.all([startA, startB]);
  return { ca, cb, roomId: fa.roomId, sa, sb };
}

describe.skipIf(!url)("two instances on one Redis", () => {
  test("users on different instances match, start a call and relay signals and chat", async () => {
    const cl = cluster();
    const a = await cl.add();
    const b = await cl.add();
    const { ca, cb, roomId, sa, sb } = await crossInstanceCall(a, b);
    expect([sa.initiator, sb.initiator].sort()).toEqual([false, true]);

    const offer = { roomId, description: { type: "offer" as const, sdp: "v=0 fake" } };
    const gotSignal = next(cb, "rtc:signal");
    ca.emit("rtc:signal", offer);
    expect(await gotSignal).toEqual(offer);

    const gotChat = next(ca, "chat:message");
    const ack = await cb.timeout(2000).emitWithAck("chat:send", { roomId, text: "hello across" });
    expect(ack).toMatchObject({ ok: true });
    const msg = await gotChat;
    expect(msg).toMatchObject({ roomId, text: "hello across" });
    if (ack.ok) expect(msg.id).toBe(ack.id);

    const gotTyping = next(cb, "chat:typing");
    ca.emit("chat:typing", { roomId, typing: true });
    expect(await gotTyping).toEqual({ roomId, typing: true });

    expect((await fetch(`${a.url}/readyz`)).status).toBe(200);
  });

  test("a disconnect on one instance notifies and re-queues the partner on the other", async () => {
    const cl = cluster();
    const a = await cl.add();
    const b = await cl.add();
    const { ca, cb, roomId } = await crossInstanceCall(a, b);
    const ended = next(cb, "match:ended");
    const waiting = next(cb, "queue:waiting");
    ca.disconnect();
    expect(await ended).toEqual({ roomId, reason: "partner-left" });
    await waiting;
    expect(await a.store.withLock(() => a.store.listWaiting())).toEqual([cb.id!]);
  });

  test("the same device on another instance replaces the old socket", async () => {
    const cl = cluster();
    const a = await cl.add();
    const b = await cl.add();
    const payload = hello();
    const oldSocket = await a.connect();
    await sendHello(oldSocket, payload);
    const replaced = next(oldSocket, "session:replaced");
    const closed = new Promise<string>((resolve) => oldSocket.once("disconnect", resolve));
    const newSocket = await b.connect();
    expect(await sendHello(newSocket, payload)).toMatchObject({ ok: true });
    await replaced;
    expect(await closed).toBe("io server disconnect");
    expect(await b.store.getDeviceSocket(payload.deviceId)).toBe(newSocket.id!);
    expect(await b.store.getSession(oldSocket.id ?? "gone")).toBeNull();
  });

  test("graceful close leaves the match lock free for the other instances", async () => {
    const cl = cluster();
    const a = await cl.add();
    const clients = await Promise.all(Array.from({ length: 6 }, () => a.connect()));
    await Promise.all(clients.map((c) => sendHello(c, hello())));
    // Slow store reads keep each disconnect cleanup inside the lock for a while.
    const getSession = a.store.getSession.bind(a.store);
    a.store.getSession = async (socketId) => {
      await Bun.sleep(30);
      return getSession(socketId);
    };
    const redis = new Redis(url!);
    cleanups.push(() => redis.quit());
    await a.server.close();
    // index.ts closes the store right after this; a cleanup still holding the
    // lock then never releases it and every instance waits out the lease.
    expect(await redis.exists(`${cl.prefix}lock:match`)).toBe(0);
    await a.store.close();
    expect(await redis.exists(`${cl.prefix}lock:match`)).toBe(0);
  });

  test("a crashed instance is reaped and its partners get partner-unavailable", async () => {
    const cl = cluster();
    // The survivor checks for dead instances every 50 ms.
    const b = await cl.add({ heartbeatIntervalMs: 50, instanceTtlMs: 200 });

    const proc = Bun.spawn([process.execPath, join(__dirname, "../fixtures/redisInstance.ts")], {
      env: { ...process.env, TEST_PREFIX: cl.prefix, TEST_ADAPTER_KEY: cl.adapterKey },
      stdout: "pipe",
      stderr: "inherit",
    });
    cleanups.push(async () => proc.kill("SIGKILL"));
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const port = Number(new TextDecoder().decode(value).trim());
    expect(port).toBeGreaterThan(0);

    const ca: Client = ioClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    cleanups.push(async () => ca.disconnect());
    await new Promise<void>((resolve, reject) => {
      ca.once("connect", () => resolve());
      ca.once("connect_error", reject);
    });
    const cb = await b.connect();
    const foundB = next(cb, "match:found");
    await sendHello(ca, hello());
    await sendHello(cb, hello());
    const { roomId } = await foundB;
    const deadSocket = ca.id!;

    const waiting = record(cb, "queue:waiting");
    const ended = next(cb, "match:ended", 3000);
    proc.kill("SIGKILL"); // no graceful shutdown, no cleanup
    expect(await ended).toEqual({ roomId, reason: "partner-unavailable" });
    for (let i = 0; i < 50 && waiting.length === 0; i++) await Bun.sleep(20);
    expect(waiting.length).toBe(1);
    // Under the lock, so the reaping that sent those events has finished.
    const [dead, queue, deadInstances] = await b.store.withLock(() =>
      Promise.all([b.store.getSession(deadSocket), b.store.listWaiting(), b.store.listDeadInstances()]),
    );
    expect(dead).toBeNull();
    expect(queue).toEqual([cb.id!]);
    expect(deadInstances).toEqual([]);
  });
});
