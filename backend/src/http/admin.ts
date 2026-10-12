/**
 * Admin API, mounted at /admin/api. Every request needs
 * `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare). Without a
 * configured token the API answers 503: it is never open. ADMIN_ALLOWED_IPS
 * limits the client IPs (the PROXY_IP_HEADER is trusted only with TRUST_PROXY). Put
 * Cloudflare Access in front in production (see DEPLOYMENT.md). CORS follows
 * CORS_ORIGINS: the console runs on the SPA host and sends the bearer token,
 * so its preflight is answered before the token check.
 *
 *   GET  /queue?status=            review queue (severity, then due clock)
 *   GET  /reports/:id              one report
 *   GET  /reports/:id/evidence     evidence JPEG download (never restricted items; audited)
 *   POST /reports/:id/action       adminReportActionSchema
 *   POST /reports/:id/escalate     CSAM escalation; returns the report packet
 *   GET  /appeals                  POST /appeals/:id/decision
 *   GET  /takedowns                POST /takedowns/:id/resolve
 *   GET  /flags                    PUT /flags (partial, validated by flagsSchema)
 *   GET  /audit?limit=&before=     audit log, newest first
 *   GET  /wallets/:deviceId        coins, active unlocks and ledger; POST /wallets/:deviceId/adjust {delta, note}
 *                                  (optional Idempotency-Key header: a repeated key is 409 duplicate, applied once)
 *   GET  /billing/orders?limit=    Razorpay orders, newest first
 * Every state change writes an audit entry (actor: the client IP; there is one admin token).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import { z } from "zod";
import type { BillingService } from "../billing/BillingService";
import type { Config } from "../config";
import { EVIDENCE_CONTENT_TYPE, EVIDENCE_EXTENSION } from "../enforcement/constants";
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
import { jsonBody } from "./body";
import { ADMIN_BODY_LIMIT_BYTES } from "./constants";
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

/** Failed logins per IP before it is locked out for the rest of the window. */
const MAX_AUTH_FAILURES = 10;
const AUTH_FAILURE_WINDOW_MS = 15 * 60_000;

function tokenMatches(header: string | undefined, token: string): boolean {
  const digest = (s: string) => new Uint8Array(createHash("sha256").update(s).digest());
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${token}`));
}

const STATUS: Record<AdminError, number> = { not_found: 404, conflict: 409, restricted: 403 };
const uuid = z.string().uuid();
/** Idempotency-Key header of the wallet adjust: a client-generated token (a UUID fits). */
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
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
  const failures = new Map<string, { count: number; resetAt: number }>();
  const ipOf = (req: Request) => requestIp(req, deps.proxyIpHeader);
  const actor = (req: Request) => ({ ip: ipOf(req) });
  const allowed = new Set(deps.adminAllowedIps);

  const guard: RequestHandler = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!deps.adminToken) return void res.status(503).json({ error: "admin_disabled" });
    const ip = ipOf(req);
    const key = ip ?? "unknown";
    if (allowed.size > 0 && (!ip || !allowed.has(ip))) return void res.status(403).json({ error: "forbidden" });
    const now = clock();
    const f = failures.get(key);
    if (f && f.resetAt <= now) failures.delete(key);
    if ((failures.get(key)?.count ?? 0) >= MAX_AUTH_FAILURES) {
      return void res.status(429).json({ error: "rate_limited" });
    }
    if (!tokenMatches(req.get("authorization"), deps.adminToken)) {
      const entry = failures.get(key) ?? { count: 0, resetAt: now + AUTH_FAILURE_WINDOW_MS };
      entry.count++;
      if (failures.size >= 10_000) failures.clear();
      failures.set(key, entry);
      deps.logger.warn({ event: "admin_auth_failed" }, "admin auth failed");
      return void res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
    }
    if (!requests.allow(ip)) return void res.status(429).json({ error: "rate_limited" });
    next();
  };
  router.use(
    apiCors(deps.corsOrigins, { methods: "GET, POST, PUT, OPTIONS", headers: "Authorization, Content-Type, Idempotency-Key" }),
  );
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
    // The bytes came from a reporter: the type is fixed server side (the store re-checks the JPEG magic
    // and the size cap), browsers must not sniff or render it inline, and nothing may cache it.
    res
      .set({
        "Content-Type": EVIDENCE_CONTENT_TYPE,
        "Content-Disposition": `attachment; filename="evidence-${id}${EVIDENCE_EXTENSION}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      })
      .send(Buffer.from(result.value));
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
    const key = req.get("idempotency-key");
    const parsedKey = key === undefined ? null : idempotencyKey.safeParse(key);
    if (!body.success || (parsedKey && !parsedKey.success)) return void res.status(400).json({ error: "invalid" });
    // A double-clicked or retried submit applies once. A request that failed after the claim needs a new key.
    if (parsedKey?.success && !(await deps.enforcement.claimAdminRequest(`wallet.adjust:${deviceId}:${parsedKey.data}`))) {
      return void res.status(409).json({ error: "duplicate" });
    }
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
