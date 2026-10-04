/**
 * HTTP surface: health, readiness, Prometheus metrics and the session gate's
 * /api routes. Everything else 404s.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type ErrorRequestHandler, type Express, type Router } from "express";
import helmet from "helmet";
import type { Registry } from "prom-client";
import type { Logger } from "../logger";
import { captureError } from "../observability/sentry";
import type { MatchStore } from "../store/MatchStore";

export interface AppDeps {
  store: MatchStore;
  registry: Registry;
  logger: Logger;
  metricsToken?: string;
  /** How long /readyz waits for the store before answering 503. */
  readyTimeoutMs?: number;
  /** /api/session, /api/config and CORS for /api (session gate). */
  session?: Router;
}

/** Constant-time compare; hashing first also hides the token length. */
function tokenMatches(header: string | undefined, token: string): boolean {
  const digest = (s: string) => new Uint8Array(createHash("sha256").update(s).digest());
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${token}`));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());

  const live: express.RequestHandler = (_req, res) => {
    res.set("Cache-Control", "no-store").json({ status: "ok" });
  };
  app.get("/healthz", live);
  app.get("/health", live); // alias kept for old CI and nginx checks

  app.get("/readyz", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      await withTimeout(deps.store.ping(), deps.readyTimeoutMs ?? 1000);
      res.json({ status: "ready" });
    } catch (err) {
      deps.logger.warn({ err }, "readiness check failed");
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.get("/metrics", async (req, res) => {
    if (deps.metricsToken && !tokenMatches(req.get("authorization"), deps.metricsToken)) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
      return;
    }
    res.set("Content-Type", deps.registry.contentType).send(await deps.registry.metrics());
  });

  if (deps.session) app.use(deps.session);

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    deps.logger.error({ err }, "http handler failed");
    captureError(err);
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  };
  app.use(onError);

  return app;
}
