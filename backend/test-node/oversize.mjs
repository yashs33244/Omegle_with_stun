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
import { setTimeout } from "node:timers";
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

// The built server keeps the session gate on, so every client gets a token first.
async function newSession() {
  const deviceId = randomUUID();
  const res = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceId,
      fingerprint: "e".repeat(64),
      age: { dob: "1990-01-01", attest18: true, tosVersion: "2026-10-draft" },
    }),
  });
  const body = await res.json();
  assert.equal(body.ok, true, `session refused: ${body.error}`);
  return { deviceId, sessionToken: body.sessionToken };
}

async function connect(session) {
  session ??= await newSession();
  const client = io(base, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    auth: { sessionToken: session.sessionToken },
  });
  return new Promise((resolve, reject) => {
    client.once("connect", () => resolve(client));
    client.once("connect_error", reject);
  });
}

const helloPayload = (deviceId) => ({
  protocolVersion: 3,
  mode: "preview",
  deviceId,
  profile: { name: "Node", country: "IN", language: "en", gender: "unspecified", topics: ["general"] },
  preferences: { genderFilter: "all", languageFilter: "any" },
});

test("the handshake refuses a socket without a session token", async () => {
  const client = io(base, { transports: ["websocket"], forceNew: true, reconnection: false });
  const [err] = await once(client, "connect_error");
  assert.equal(err.data?.code, "session_required");
  client.close();
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
  const session = await newSession();
  const fresh = await connect(session);
  const ack = await fresh.timeout(2000).emitWithAck("session:hello", helloPayload(session.deviceId));
  assert.equal(ack.ok, true);
  bystander.disconnect();
  fresh.disconnect();
});

test("binary attachments close the sender instead of being buffered", async () => {
  const attacker = await connect();
  const closed = once(attacker, "disconnect");
  const engine = attacker.io.engine;
  engine.write('51000000-["chat:send",{"_placeholder":true,"num":0}]');
  for (let i = 0; i < 5; i++) engine.write(new Uint8Array(64 * 1024));
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("not disconnected")), 2000).unref());
  const [reason] = await Promise.race([closed, timeout]);
  assert.match(reason, /^transport (close|error)$/);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
});
