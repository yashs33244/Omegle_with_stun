/**
 * Every admin route sits behind the bearer guard: enumerated from the router
 * stack (so a new route cannot slip in unlisted) and exercised over HTTP with
 * deps that throw if a route body runs without a valid token.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import pino from "pino";
import type { BillingService } from "../../src/billing/BillingService";
import type { EnforcementService } from "../../src/enforcement/EnforcementService";
import type { FlagsReader } from "../../src/flags/flags";
import { adminApiRouter, type AdminApiDeps } from "../../src/http/admin";

const TOKEN = "admin-token-0123456789-abcdefghij";

/** Every route the admin API exposes. Adding a route means adding it here. */
const ROUTES: [method: string, path: string][] = [
  ["GET", "/queue"],
  ["GET", "/reports/:id"],
  ["GET", "/reports/:id/evidence"],
  ["POST", "/reports/:id/action"],
  ["POST", "/reports/:id/escalate"],
  ["GET", "/appeals"],
  ["POST", "/appeals/:id/decision"],
  ["GET", "/takedowns"],
  ["POST", "/takedowns/:id/resolve"],
  ["GET", "/flags"],
  ["PUT", "/flags"],
  ["GET", "/audit"],
  ["GET", "/wallets/:id"],
  ["POST", "/wallets/:id/adjust"],
  ["GET", "/billing/orders"],
];

/** Any property access on a dependency means a route body ran. */
function tripwire<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      throw new Error(`${name}.${String(prop)} reached without admin auth`);
    },
  });
}

interface Layer {
  name: string;
  route?: { path: string; methods: Record<string, boolean> };
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

function build(deps: Partial<AdminApiDeps> = {}) {
  const router = adminApiRouter({
    enforcement: tripwire<EnforcementService>("enforcement"),
    billing: tripwire<BillingService>("billing"),
    flags: tripwire<FlagsReader>("flags"),
    logger: pino({ level: "silent" }),
    adminToken: TOKEN,
    adminAllowedIps: [],
    proxyIpHeader: null,
    corsOrigins: ["https://console.example"],
    ...deps,
  });
  return router;
}

async function listen(router: express.Router): Promise<string> {
  const app = express();
  app.use("/admin/api", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/admin/api`;
}

const concrete = (path: string) => path.replace(":id", randomUUID());

describe("admin router auth", () => {
  test("the guard precedes every route and the route list is complete", () => {
    const stack = (build() as unknown as { stack: Layer[] }).stack;
    const guardIndex = stack.findIndex((l) => l.name === "guard");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    const routes = stack
      .map((l, i) => ({ i, route: l.route }))
      .filter((l): l is { i: number; route: NonNullable<Layer["route"]> } => l.route !== undefined);
    expect(routes.length).toBeGreaterThan(0);
    for (const { i } of routes) expect(i).toBeGreaterThan(guardIndex);
    const found = routes.flatMap(({ route }) => Object.keys(route.methods).map((m) => `${m.toUpperCase()} ${route.path}`)).sort();
    expect(found).toEqual(ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  });

  test("every route answers 401 without or with a wrong token, 503 when no token is configured, 403 off the allowlist", async () => {
    const base = await listen(build({ proxyIpHeader: "x-real-ip" }));
    // One source address per route so the test stays under the 10-failure lockout.
    for (const [n, [method, path]] of ROUTES.entries()) {
      const url = `${base}${concrete(path)}`;
      const from = { "x-real-ip": `203.0.113.${n + 1}` };
      const missing = await fetch(url, { method, headers: from });
      expect([method, path, missing.status]).toEqual([method, path, 401]);
      expect(missing.headers.get("www-authenticate")).toBe("Bearer");
      expect(missing.headers.get("cache-control")).toBe("no-store");
      const wrong = await fetch(url, { method, headers: { ...from, authorization: `Bearer ${TOKEN.slice(0, -1)}x` } });
      expect([method, path, wrong.status]).toEqual([method, path, 401]);
      const query = await fetch(`${url}?token=${TOKEN}&authorization=Bearer%20${TOKEN}`, { method, headers: from });
      expect([method, path, query.status]).toEqual([method, path, 401]);
    }
    // Unknown paths under the prefix are guarded too (no route enumeration without a token).
    expect((await fetch(`${base}/nope`)).status).toBe(401);
    // Preflight is answered before the guard, for the console origin only, and leaks nothing.
    const preflight = await fetch(`${base}/queue`, { method: "OPTIONS", headers: { origin: "https://console.example" } });
    expect(preflight.status).toBe(204);
    expect((await fetch(`${base}/queue`, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(401);
    server!.close();

    const disabled = await listen(build({ adminToken: undefined }));
    for (const [method, path] of ROUTES) {
      const res = await fetch(`${disabled}${concrete(path)}`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
      expect([method, path, res.status]).toEqual([method, path, 503]);
    }
    server!.close();

    const allowlisted = await listen(build({ adminAllowedIps: ["203.0.113.7"] }));
    for (const [method, path] of ROUTES) {
      const res = await fetch(`${allowlisted}${concrete(path)}`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
  });

  test("ten bad tokens lock the IP out for the window, and a spoofed proxy header does not give it a fresh identity", async () => {
    let now = 1_000_000;
    const base = await listen(build({ clock: () => now, proxyIpHeader: "x-real-ip" }));
    for (let i = 0; i < 10; i++) {
      expect((await fetch(`${base}/queue`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    }
    // The eleventh is refused before the token is even looked at, right token included.
    expect((await fetch(`${base}/queue`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(429);
    // A junk proxy header is not an address, so it is still the same peer.
    expect((await fetch(`${base}/queue`, { headers: { authorization: `Bearer ${TOKEN}`, "x-real-ip": "fresh-identity" } })).status).toBe(429);
    now += 15 * 60_000;
    // After the window the right token reaches the route body (the tripwire deps turn that into a 500).
    expect((await fetch(`${base}/queue`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(500);
  });
});
