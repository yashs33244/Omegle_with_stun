// Runs the BUILT server (dist/) under Node, the production runtime, and
// proves an oversized WebSocket frame drops only that client.
// Run with: bun run build && bun run test:node (not named *.test.mjs, so bun test skips it)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let server;
let base;

before(async () => {
  server = spawn(process.execPath, [join(root, "dist/index.js")], {
    env: { ...process.env, NODE_ENV: "test", PORT: "0", LOG_LEVEL: "info", REDIS_URL: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: server.stdout });
  for await (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.msg === "listening") {
      base = `http://127.0.0.1:${entry.port}`;
      break;
    }
  }
  assert.ok(base, "server did not report its port");
});

after(async () => {
  server.kill("SIGTERM");
  await once(server, "exit");
});

function connect() {
  const client = io(base, { transports: ["websocket"], forceNew: true, reconnection: false });
  return new Promise((resolve, reject) => {
    client.once("connect", () => resolve(client));
    client.once("connect_error", reject);
  });
}

const helloPayload = () => ({
  protocolVersion: 3,
  mode: "preview",
  deviceId: randomUUID(),
  profile: { name: "Node", country: "IN", language: "en", gender: "unspecified", topics: ["general"] },
  preferences: { genderFilter: "all", languageFilter: "any" },
});

test("an oversized frame closes only the sender; the server stays healthy", async () => {
  const bystander = await connect();
  const attacker = await connect();
  const closed = once(attacker, "disconnect");
  attacker.emit("chat:send", { roomId: randomUUID(), text: "x".repeat(2 * 1024 * 1024) });
  const [reason] = await closed;
  assert.match(reason, /^transport (close|error)$/);

  assert.equal(bystander.connected, true);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  const fresh = await connect();
  const ack = await fresh.timeout(2000).emitWithAck("session:hello", helloPayload());
  assert.equal(ack.ok, true);
  bystander.disconnect();
  fresh.disconnect();
});
