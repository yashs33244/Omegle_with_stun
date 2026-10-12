/**
 * Heap cost of one open socket with a session, the measurement behind the
 * default MAX_CONNECTIONS_TOTAL (docs/LIMITS.md "Instance-wide limits and
 * shedding"). The clients are Bun's native WebSocket speaking Engine.IO by
 * hand, so their own JS heap is small next to the server's.
 */
import { afterEach, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { hello, prefs, profile, startServer, type TestServer } from "../helpers";

let ts: TestServer | undefined;
afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

const SOCKETS = 500;
const PER_SOCKET_HEAP_CEILING = 32 * 1024;
const DEFAULT_CAP_HEAP_BUDGET = 64 * 1024 * 1024;

/** Opens a socket, joins the namespace and says hello (unmatchable); resolves once it is in the queue. */
async function waitingClient(url: string): Promise<WebSocket> {
  const ws = new WebSocket(`${url.replace("http", "ws")}/socket.io/?EIO=4&transport=websocket`);
  const queued = Promise.withResolvers<void>();
  const payload = hello({ profile: profile({ language: "en" }), preferences: prefs({ languageFilter: "hi" }) });
  ws.onmessage = ({ data }) => {
    const packet = String(data);
    if (packet.startsWith("0")) ws.send("40");
    else if (packet.startsWith("40")) ws.send(`420${JSON.stringify(["session:hello", payload])}`);
    else if (packet.startsWith("430") && !packet.includes('"ok":true')) queued.reject(new Error(`hello refused: ${packet}`));
    else if (packet.startsWith('42["queue:waiting"')) queued.resolve();
  };
  ws.onerror = () => queued.reject(new Error("websocket error"));
  await queued.promise;
  return ws;
}

function heapAfterGc(): number {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
}

test(`${SOCKETS} waiting sockets cost the server little enough heap for the default MAX_CONNECTIONS_TOTAL`, async () => {
  ts = await startServer();
  const { url } = ts;
  // Warm up every code path once so lazily built state is not billed to the
  // sample; it stays open so its cleanup does not overlap the measurement.
  const warm = await waitingClient(url);
  const before = heapAfterGc();
  const sockets: WebSocket[] = [];
  while (sockets.length < SOCKETS) sockets.push(...(await Promise.all(Array.from({ length: 50 }, () => waitingClient(url)))));
  const perSocket = (heapAfterGc() - before) / SOCKETS;
  expect((await ts.store.stats()).waiting).toBe(SOCKETS + 1);
  for (const ws of [warm, ...sockets]) ws.close();
  // Measured about 21 KiB here (Bun, clients included) and 17 KiB under Node 22
  // (server only, docs/LIMITS.md). A regression past this is worth a look.
  expect(perSocket).toBeLessThan(PER_SOCKET_HEAP_CEILING);
  // The default cap of idle sockets stays a small part of the heap shedding
  // allows on a 512 MB instance (about 246 MB), leaving the rest to photos,
  // calls and bursts; the heap check in LoadMonitor covers the worst case.
  expect(perSocket * loadConfig({}).maxConnectionsTotal).toBeLessThan(DEFAULT_CAP_HEAP_BUDGET);
}, 30_000);
