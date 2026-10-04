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
import { requestCountry, requestIp } from "../session/geo";
import type { SessionService } from "../session/SessionService";

export function apiCors(allowed: Config["corsOrigins"]): RequestHandler {
  return (req, res, next) => {
    const origin = req.get("origin");
    if (origin && (allowed === "*" || allowed.includes(origin))) {
      res.set("Access-Control-Allow-Origin", allowed === "*" ? "*" : origin);
      res.vary("Origin");
      if (req.method === "OPTIONS") {
        res.set({
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
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
}

export function createSessionRouter(deps: SessionRouterDeps): Router {
  const { config, flags, service, logger } = deps;
  const router = express.Router();
  router.use("/api", apiCors(config.corsOrigins));

  router.get("/api/config", (_req, res) => {
    res.set("Cache-Control", "public, max-age=30").json(publicConfig(config, flags));
  });

  router.post("/api/session", express.json({ limit: "8kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const result = await service.create(req.body, {
      ip: requestIp(req.headers, req.socket.remoteAddress, config.trustProxy),
      country: requestCountry(req.headers, config.trustCloudflare),
    });
    res.status(result.status).json(result.body);
  });

  // Body parser errors carry the raw body, which may hold a date of birth: answer
  // without logging the error object.
  const bodyErrors: ErrorRequestHandler = (err, _req, res, next) => {
    const type = (err as { type?: unknown }).type;
    if (typeof type !== "string" || !type.startsWith("entity.")) return next(err);
    logger.debug({ type }, "rejected a malformed session request body");
    res.status(type === "entity.too.large" ? 413 : 400).json({ ok: false, error: "invalid" });
  };
  router.use("/api/session", bodyErrors);

  return router;
}
