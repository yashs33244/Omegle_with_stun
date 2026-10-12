/**
 * Admin API, mounted at /admin/api. Every request needs
 * `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare). Without a
 * configured token the API answers 503: it is never open. ADMIN_ALLOWED_IPS
 * limits the client IPs to listed addresses and CIDR blocks (the
 * PROXY_IP_HEADER is trusted only with TRUST_PROXY). Bad tokens are limited
 * per subscriber address (IPv4 address, IPv6 /64) and, against distributed
 * guessing, by an instance-wide budget after which one bad token locks an
 * address out (http/constants.ts). Put Cloudflare Access in front in production (see
 * DEPLOYMENT.md). CORS follows CORS_ORIGINS: the console runs on the SPA host
 * and sends the bearer token, so its preflight is answered before the token
 * check.
 *
 *   GET  /queue?status=            review queue (severity, then due clock)
 *   GET  /reports/:id              one report
 *   GET  /reports/:id/evidence     evidence JPEG (never restricted items; audited)
 *   POST /reports/:id/action       adminReportActionSchema
 *   POST /reports/:id/escalate     CSAM escalation; returns the report packet
 *   GET  /appeals                  POST /appeals/:id/decision
 *   GET  /takedowns                POST /takedowns/:id/resolve
 *   GET  /flags                    PUT /flags (partial, validated by flagsSchema)
 *   GET  /audit?limit=&before=     audit log, newest first
 *   GET  /wallets/:deviceId        coins, active unlocks and ledger; POST /wallets/:deviceId/adjust {delta, note}
 *   GET  /billing/orders?limit=    Razorpay orders, newest first
 * Every state change writes an audit entry.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { BlockList, isIPv4 } from "node:net";
import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import { z } from "zod";
import type { BillingService } from "../billing/BillingService";
import { parseIpRange, type Config } from "../config";
import type { AdminError, AdminResult, EnforcementService } from "../enforcement/EnforcementService";
import type { FlagsReader } from "../flags/flags";
import type { Logger } from "../logger";
import {
  adminAppealDecisionSchema,
  adminReportActionSchema,
  adminTakedownResolveSchema,
  adminWalletAdjustSchema,
  flagsSchema,
  type AdminWalletView,
} from "../protocol";
import { ipBuckets } from "../session/geo";
import { jsonBody } from "./body";
import {
  ADMIN_AUTH_FAILURE_WINDOW_MS,
  ADMIN_BODY_LIMIT_BYTES,
  ADMIN_FAILURE_MAP_MAX,
  ADMIN_FAILURE_SWEEP_MS,
  ADMIN_GLOBAL_FAILURE_WINDOW_MS,
  ADMIN_MAX_AUTH_FAILURES_GLOBAL,
  ADMIN_MAX_AUTH_FAILURES_PER_IP,
} from "./constants";
import { IpBuckets, jsonErrors, requestIp } from "./public";
import { apiCors } from "./session";

export interface AdminApiDeps {
  enforcement: EnforcementService;
  billing: BillingService;
  flags: FlagsReader;
  logger: Logger;
  adminToken?: string;
  adminAllowedIps: string[];
  proxyIpHeader: string | null;
  corsOrigins: Config["corsOrigins"];
  clock?: () => number;
}

/** ADMIN_ALLOWED_IPS as a BlockList of addresses and CIDR blocks, or null when unset (any IP). */
export function adminAllowList(entries: string[]): BlockList | null {
  if (entries.length === 0) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const range = parseIpRange(entry);
    // loadConfig refuses these; fail closed for a hand-built config too.
    if (!range) throw new Error(`invalid ADMIN_ALLOWED_IPS entry "${entry}"`);
    if (range.prefix === null) list.addAddress(range.address, range.type);
    else list.addSubnet(range.address, range.prefix, range.type);
  }
  return list;
}

/** Loud startup warnings for an admin API weaker than production needs. */
export function adminWarnings(config: Pick<Config, "nodeEnv" | "adminAllowedIps">): string[] {
  if (config.nodeEnv !== "production" || config.adminAllowedIps.length > 0) return [];
  return [
    "ADMIN_ALLOWED_IPS is empty: the admin API is open to every IP and guarded only by ADMIN_TOKEN and the failure limits " +
      "(set it to your IPs or CIDR blocks, or put Cloudflare Access in front)",
  ];
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const digest = (s: string) => new Uint8Array(createHash("sha256").update(s).digest());
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${token}`));
}

const STATUS: Record<AdminError, number> = { not_found: 404, conflict: 409, restricted: 403 };
const uuid = z.string().uuid();
const queueStatus = z.enum(["open", "acknowledged", "actioned", "dismissed", "escalated", "all"]).optional();
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
});

function send<T>(res: Response, result: AdminResult<T>): void {
  if (result.ok) res.json(result.value);
  else res.status(STATUS[result.error]).json({ error: result.error });
}

export function adminApiRouter(deps: AdminApiDeps): Router {
  const router = express.Router();
  const json = jsonBody(ADMIN_BODY_LIMIT_BYTES);
  const clock = deps.clock ?? Date.now;
  const requests = new IpBuckets({ capacity: 120, refillPerSec: 2 }, clock);
  /**
   * Bad tokens per subscriber address (IPv4 address, IPv6 /64): its own count
   * in its per-address window, and the global window it last failed in.
   */
  const failures = new Map<string, { count: number; resetAt: number; window: number }>();
  /** Bad tokens from every address on this instance; the window starts at the first one. */
  const globalFailures = { count: 0, resetAt: 0 };
  let lastSweep = 0;
  const ipOf = (req: Request) => requestIp(req, deps.proxyIpHeader);
  const actor = (req: Request) => ({ ip: ipOf(req) });
  const allowed = adminAllowList(deps.adminAllowedIps);

  /** Drops records that no longer lock anything, at most once per ADMIN_FAILURE_SWEEP_MS (it walks the whole map). */
  const sweep = (now: number) => {
    if (failures.size < ADMIN_FAILURE_MAP_MAX || now - lastSweep < ADMIN_FAILURE_SWEEP_MS) return;
    lastSweep = now;
    for (const [k, v] of failures) if (v.resetAt <= now && v.window !== globalFailures.resetAt) failures.delete(k);
  };

  const guard: RequestHandler = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!deps.adminToken) return void res.status(503).json({ error: "admin_disabled" });
    const ip = ipOf(req);
    if (allowed && (!ip || !allowed.check(ip, isIPv4(ip) ? "ipv4" : "ipv6"))) {
      return void res.status(403).json({ error: "forbidden" });
    }
    const key = ip ? ipBuckets(ip).ip : "unknown";
    const now = clock();
    if (globalFailures.resetAt <= now) globalFailures.count = 0;
    const f = failures.get(key);
    const ipLocked = f !== undefined && f.resetAt > now && f.count >= ADMIN_MAX_AUTH_FAILURES_PER_IP;
    // Once the instance-wide budget is spent, one failure in this window locks
    // an address out; addresses without one are still judged by their token,
    // so guessers cannot lock the owner out. Only when the records are full
    // (failures from ADMIN_FAILURE_MAP_MAX addresses) do unknown ones wait too.
    const exhausted = globalFailures.count >= ADMIN_MAX_AUTH_FAILURES_GLOBAL;
    if (exhausted && !f) sweep(now);
    const globalLocked = exhausted && (f ? f.window === globalFailures.resetAt : failures.size >= ADMIN_FAILURE_MAP_MAX);
    if (ipLocked || globalLocked) {
      const until = Math.max(ipLocked && f ? f.resetAt : 0, globalLocked ? globalFailures.resetAt : 0);
      res.set("Retry-After", String(Math.ceil((until - now) / 1000)));
      return void res.status(429).json({ error: "rate_limited" });
    }
    if (!tokenMatches(req.get("authorization"), deps.adminToken)) {
      const entry = f && f.resetAt > now ? f : { count: 0, resetAt: now + ADMIN_AUTH_FAILURE_WINDOW_MS, window: 0 };
      entry.count++;
      if (globalFailures.count === 0) globalFailures.resetAt = now + ADMIN_GLOBAL_FAILURE_WINDOW_MS;
      globalFailures.count++;
      entry.window = globalFailures.resetAt;
      sweep(now);
      if (failures.has(key) || failures.size < ADMIN_FAILURE_MAP_MAX) failures.set(key, entry);
      deps.logger.warn({ event: "admin_auth_failed" }, "admin auth failed");
      if (globalFailures.count === ADMIN_MAX_AUTH_FAILURES_GLOBAL) {
        deps.logger.error(
          { event: "admin_auth_budget_exhausted", failures: globalFailures.count, until: new Date(globalFailures.resetAt).toISOString() },
          "admin auth failure budget exhausted: every address with a bad token this window is locked out until it ends",
        );
      }
      return void res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
    }
    if (!requests.allow(ip)) return void res.status(429).json({ error: "rate_limited" });
    next();
  };
  router.use(apiCors(deps.corsOrigins, { methods: "GET, POST, PUT, OPTIONS", headers: "Authorization, Content-Type" }));
  router.use(guard);

  /** Ids are UUIDs; anything else is a 404 without touching the store. */
  const idParam = (req: Request, res: Response): string | null => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) res.status(404).json({ error: "not_found" });
    return id.success ? id.data : null;
  };

  router.get("/queue", async (req, res) => {
    const status = queueStatus.safeParse(req.query.status);
    if (!status.success) return void res.status(400).json({ error: "invalid" });
    res.json(await deps.enforcement.queue(status.data));
  });

  router.get("/reports/:id", async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const report = await deps.enforcement.report(id);
    if (!report) return void res.status(404).json({ error: "not_found" });
    res.json(report);
  });

  router.get("/reports/:id/evidence", async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const result = await deps.enforcement.evidenceImage(id, actor(req));
    if (!result.ok) return void res.status(STATUS[result.error]).json({ error: result.error });
    res.set("Content-Type", "image/jpeg").send(Buffer.from(result.value));
  });

  router.post("/reports/:id/action", json, async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const body = adminReportActionSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "invalid" });
    send(res, await deps.enforcement.actOnReport(id, body.data, actor(req)));
  });

  router.post("/reports/:id/escalate", json, async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const body = z.object({ note: z.string().max(2_000).optional() }).safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ error: "invalid" });
    send(res, await deps.enforcement.escalate(id, actor(req), body.data.note));
  });

  router.get("/appeals", async (_req, res) => {
    res.json(await deps.enforcement.listAppeals());
  });

  router.post("/appeals/:id/decision", json, async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const body = adminAppealDecisionSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "invalid" });
    send(res, await deps.enforcement.decideAppeal(id, body.data.decision, body.data.note, actor(req)));
  });

  router.get("/takedowns", async (_req, res) => {
    res.json(await deps.enforcement.listTakedowns());
  });

  router.post("/takedowns/:id/resolve", json, async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const body = adminTakedownResolveSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "invalid" });
    send(res, await deps.enforcement.resolveTakedown(id, body.data.resolution, actor(req)));
  });

  router.get("/flags", async (_req, res) => {
    res.json(await deps.flags.store.get());
  });

  router.put("/flags", json, async (req, res) => {
    const patch = flagsSchema.partial().strict().safeParse(req.body);
    if (!patch.success || Object.keys(patch.data).length === 0) {
      return void res.status(400).json({ error: "invalid" });
    }
    const flags = await deps.flags.set(patch.data);
    await deps.enforcement.audit("flags.update", Object.keys(patch.data).join(","), JSON.stringify(patch.data), actor(req).ip);
    res.json(flags);
  });

  router.get("/audit", async (req, res) => {
    const q = auditQuery.safeParse(req.query);
    if (!q.success) return void res.status(400).json({ error: "invalid" });
    res.json(await deps.enforcement.listAudit(q.data.limit, q.data.before));
  });

  router.get("/wallets/:id", async (req, res) => {
    const deviceId = idParam(req, res);
    if (!deviceId) return;
    const [view, ledger] = await Promise.all([deps.billing.walletView(deviceId), deps.billing.ledger(deviceId)]);
    res.json({ deviceId, ...view, ledger } satisfies AdminWalletView);
  });

  router.post("/wallets/:id/adjust", json, async (req, res) => {
    const deviceId = idParam(req, res);
    if (!deviceId) return;
    const body = adminWalletAdjustSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "invalid" });
    const view = await deps.billing.adjust(deviceId, body.data.delta, body.data.note);
    await deps.enforcement.audit("wallet.adjust", deviceId, `${body.data.delta > 0 ? "+" : ""}${body.data.delta}: ${body.data.note}`, actor(req).ip);
    res.json({ deviceId, ...view, ledger: await deps.billing.ledger(deviceId) } satisfies AdminWalletView);
  });

  router.get("/billing/orders", async (req, res) => {
    const q = auditQuery.pick({ limit: true }).safeParse(req.query);
    if (!q.success) return void res.status(400).json({ error: "invalid" });
    res.json(await deps.billing.listOrders(q.data.limit));
  });

  router.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  router.use(jsonErrors(deps.logger));
  return router;
}
