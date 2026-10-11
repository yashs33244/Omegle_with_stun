/**
 * Public enforcement endpoints (same origin as the socket server):
 *   GET  /api/restrictions/:id?deviceId=  the restricted device reads its own restriction
 *   POST /api/appeals                     one appeal per restriction
 *   POST /api/takedowns                   notice-and-removal tickets (Turnstile verified)
 * Bodies are capped at 16 KB and validated with the protocol schemas.
 */
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Router } from "express";
import { z } from "zod";
import type { EnforcementService } from "../enforcement/EnforcementService";
import type { Logger } from "../logger";
import { appealRequestSchema, takedownRequestSchema, type AppealResponse, type TakedownResponse } from "../protocol";
import { TokenBucket, type BucketSpec } from "../rateLimit";
import { UNKNOWN_IP } from "../session/constants";
import { requestIp as clientIp } from "../session/geo";

/** Client IP of an Express request (see session/geo.ts requestIp), or null when unknown. */
export function requestIp(req: Request, proxyIpHeader: string | null): string | null {
  const ip = clientIp(req.headers, req.socket.remoteAddress, proxyIpHeader);
  return ip === UNKNOWN_IP ? null : ip;
}

/** Per-IP token buckets for one instance. Cleared when it grows large, so it cannot leak memory. */
export class IpBuckets {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly spec: BucketSpec,
    private readonly clock: () => number = Date.now,
  ) {}

  allow(ip: string | null): boolean {
    const key = ip ?? "unknown";
    const now = this.clock();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 50_000) this.buckets.clear();
      bucket = new TokenBucket(this.spec, now);
      this.buckets.set(key, bucket);
    }
    return bucket.take(now);
  }
}

export interface PublicApiDeps {
  enforcement: EnforcementService;
  proxyIpHeader: string | null;
  logger: Logger;
}

const uuid = z.string().uuid();

const APPEAL_STATUS: Record<Exclude<AppealResponse, { ok: true }>["error"], number> = {
  invalid: 400,
  not_found: 404,
  already_appealed: 409,
  not_appealable: 409,
  rate_limited: 429,
};

const TAKEDOWN_STATUS: Record<Exclude<TakedownResponse, { ok: true }>["error"], number> = {
  invalid: 400,
  turnstile_failed: 403,
  rate_limited: 429,
};

export function publicApiRouter(deps: PublicApiDeps): Router {
  const router = express.Router();
  const json = express.json({ limit: "16kb" });
  // Per-instance burst cap in front of the store-backed limits in EnforcementService.
  const reads = new IpBuckets({ capacity: 30, refillPerSec: 0.5 });
  const writes = new IpBuckets({ capacity: 10, refillPerSec: 0.1 });
  const ip = (req: Request) => requestIp(req, deps.proxyIpHeader);

  const noStore: RequestHandler = (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  };

  router.get("/api/restrictions/:id", noStore, async (req, res) => {
    if (!reads.allow(ip(req))) return void res.status(429).json({ error: "rate_limited" });
    const id = uuid.safeParse(req.params.id);
    const deviceId = uuid.safeParse(req.query.deviceId);
    if (!id.success || !deviceId.success) return void res.status(400).json({ error: "invalid" });
    const view = await deps.enforcement.restrictionView(id.data, deviceId.data);
    if (!view) return void res.status(404).json({ error: "not_found" });
    res.json(view);
  });

  router.post("/api/appeals", noStore, json, async (req, res) => {
    if (!writes.allow(ip(req))) return void res.status(429).json({ ok: false, error: "rate_limited" });
    const parsed = appealRequestSchema.safeParse(req.body);
    const result: AppealResponse = parsed.success
      ? await deps.enforcement.submitAppeal(parsed.data, ip(req))
      : { ok: false, error: "invalid" };
    res.status(result.ok ? 201 : APPEAL_STATUS[result.error]).json(result);
  });

  router.post("/api/takedowns", noStore, json, async (req, res) => {
    if (!writes.allow(ip(req))) return void res.status(429).json({ ok: false, error: "rate_limited" });
    const parsed = takedownRequestSchema.safeParse(req.body);
    const result: TakedownResponse = parsed.success
      ? await deps.enforcement.submitTakedown(parsed.data, ip(req))
      : { ok: false, error: "invalid" };
    res.status(result.ok ? 201 : TAKEDOWN_STATUS[result.error]).json(result);
  });

  router.use(jsonErrors(deps.logger));
  return router;
}

/** Body parser errors become 400/413 instead of the app's generic 500. */
export function jsonErrors(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, next) => {
    const status = (err as { status?: number }).status;
    if (status === 400 || status === 413 || status === 415) {
      res.status(status).json({ ok: false, error: status === 413 ? "too_large" : "invalid" });
      return;
    }
    logger.error({ err }, "enforcement http handler failed");
    next(err);
  };
}
