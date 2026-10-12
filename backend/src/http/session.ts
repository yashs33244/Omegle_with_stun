/**
 * Public REST routes of the session gate: POST /api/session and GET /api/config,
 * plus CORS for everything under /api (the SPA and the API live on different
 * hosts). Mount this router before any other /api route so they share the CORS
 * handling.
 */
import express, { type ErrorRequestHandler, type RequestHandler, type Router } from "express";
import type { Config } from "../config";
import { describeStaffedHours, type FlagsReader } from "../flags/flags";
import type { Logger } from "../logger";
import { TOS_VERSION, type PublicConfig } from "../protocol";
import { ipBuckets, requestCountry, requestIp } from "../session/geo";
import type { SessionService } from "../session/SessionService";
import { SHED_RETRY_AFTER_SEC } from "../shed/constants";
import type { Shedder } from "../shed/Shedder";
import { jsonBody } from "./body";
import { SESSION_BODY_LIMIT_BYTES, SESSION_BURST_FACTOR } from "./constants";
import { IpBuckets, requestIp as bucketIp } from "./public";

export function apiCors(
  allowed: Config["corsOrigins"],
  preflight: { methods: string; headers: string } = { methods: "GET, POST, OPTIONS", headers: "Authorization, Content-Type" },
): RequestHandler {
  return (req, res, next) => {
    const origin = req.get("origin");
    if (origin && (allowed === "*" || allowed.includes(origin))) {
      res.set("Access-Control-Allow-Origin", allowed === "*" ? "*" : origin);
      // Retry-After is not CORS-safelisted; the SPA reads it on a 503.
      res.set("Access-Control-Expose-Headers", "Retry-After");
      res.vary("Origin");
      if (req.method === "OPTIONS") {
        res.set({
          "Access-Control-Allow-Methods": preflight.methods,
          "Access-Control-Allow-Headers": preflight.headers,
          "Access-Control-Max-Age": "600",
        });
        res.status(204).end();
        return;
      }
    }
    next();
  };
}

export function publicConfig(config: Config, flags: FlagsReader, now = Date.now()): PublicConfig {
  const f = flags.current();
  const status = flags.status(now);
  return {
    tosVersion: TOS_VERSION,
    turnstileSiteKey: config.turnstileSecret ? (config.turnstileSiteKey ?? null) : null,
    sentryDsn: config.sentryDsnFrontend ?? null,
    posthogKey: config.posthogKey ?? null,
    posthogHost: config.posthogHost ?? null,
    banner: f.banner_message || null,
    matchingOpen: status.open,
    staffedHours: describeStaffedHours(f.staffed_hours),
    reopensAt: status.reopensAt,
    defaultMode: f.default_mode,
    privateModeEnabled: f.private_mode_enabled,
  };
}

export interface SessionRouterDeps {
  config: Config;
  flags: FlagsReader;
  service: SessionService;
  logger: Logger;
  /** Counts requests the per-instance burst cap refused (they never reach the service). */
  onRateLimited?: () => void;
  /** Instance-wide shedding (shed/Shedder.ts). */
  shed: Pick<Shedder, "admitSessionLoad" | "takeSession">;
}

export function createSessionRouter(deps: SessionRouterDeps): Router {
  const { config, flags, service, logger } = deps;
  const router = express.Router();
  router.use("/api", apiCors(config.corsOrigins));

  router.get("/api/config", (_req, res) => {
    res.set("Cache-Control", "public, max-age=30").json(publicConfig(config, flags));
  });

  // Per-instance burst cap in front of the store-backed per-minute limits: a
  // flood from one address is answered here, before the body is parsed and
  // without a store round trip. Looser than the store limit so it never bites first.
  const burst = new IpBuckets({
    capacity: SESSION_BURST_FACTOR * config.sessionRatePerIpPerMin,
    refillPerSec: config.sessionRatePerIpPerMin / 60,
  });
  const burstCap: RequestHandler = (req, res, next) => {
    if (burst.allow(bucketIp(req, config.proxyIpHeader))) return next();
    deps.onRateLimited?.();
    res.set("Cache-Control", "no-store").status(429).json({ ok: false, error: "rate_limited" });
  };

  // The same per network (IPv4 /24, IPv6 /48), looser than the store-backed
  // per-network limit: an IPv6 allocation holds thousands of /64s, each with
  // its own burst, so without it one /48 could empty the instance-wide bucket.
  const networkBurst = new IpBuckets({
    capacity: SESSION_BURST_FACTOR * config.sessionRatePerNetworkPerMin,
    refillPerSec: config.sessionRatePerNetworkPerMin / 60,
  });
  const networkCap: RequestHandler = (req, res, next) => {
    const ip = bucketIp(req, config.proxyIpHeader);
    // IpBuckets keys anything that is not an address as given: the network key.
    if (networkBurst.allow(ip === null ? null : ipBuckets(ip).network)) return next();
    deps.onRateLimited?.();
    res.set("Cache-Control", "no-store").status(429).json({ ok: false, error: "rate_limited" });
  };

  // Instance-wide shedding: overload is checked before the per-IP bucket is
  // charged, the instance-wide bucket after the per-IP and per-network ones,
  // so one address or network cannot empty the shared bucket faster than its
  // own burst allows.
  const { shed } = deps;
  const closed = (res: express.Response) =>
    void res.set({ "Cache-Control": "no-store", "Retry-After": String(SHED_RETRY_AFTER_SEC) }).status(503).json({ ok: false, error: "closed" });
  const shedLoad: RequestHandler = (_req, res, next) => (shed.admitSessionLoad() ? next() : closed(res));
  const shedRate: RequestHandler = (_req, res, next) => (shed.takeSession() ? next() : closed(res));

  router.post("/api/session", shedLoad, burstCap, networkCap, shedRate, jsonBody(SESSION_BODY_LIMIT_BYTES), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const result = await service.create(req.body, {
      ip: requestIp(req.headers, req.socket.remoteAddress, config.proxyIpHeader),
      country: requestCountry(req.headers, config.trustCloudflare),
    });
    // `closed` with new sessions enabled is transient (Turnstile verification
    // saturated): Retry-After tells the client to come back, unlike the kill switch.
    if (!result.body.ok && result.body.error === "closed" && flags.current().new_sessions_enabled) {
      res.set("Retry-After", String(SHED_RETRY_AFTER_SEC));
    }
    if (result.retryAfterSec !== undefined) res.set("Retry-After", String(result.retryAfterSec));
    res.status(result.status).json(result.body);
  });

  // Body parser errors carry the raw body, which may hold a date of birth: answer
  // without logging the error object.
  const bodyErrors: ErrorRequestHandler = (err, _req, res, next) => {
    const { type, status } = err as { type?: unknown; status?: unknown };
    if (typeof type !== "string" || (status !== 400 && status !== 413 && status !== 415)) return next(err);
    logger.debug({ type }, "rejected a malformed session request body");
    res.status(status).json({ ok: false, error: "invalid" });
  };
  router.use("/api/session", bodyErrors);

  return router;
}
