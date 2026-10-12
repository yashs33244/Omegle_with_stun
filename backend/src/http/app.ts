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
  /**
   * Production: without a token /metrics answers 404 instead of being open
   * (hosts without the gateway, such as Render, expose the port directly).
   */
  metricsRequireToken: boolean;
  /** How long /readyz waits for the store before answering 503. */
  readyTimeoutMs?: number;
  /**
   * True while the instance sheds new work (shed/Shedder.ts): /readyz answers
   * 503 so a balancer stops sending new clients, /healthz stays 200 so a busy
   * instance is not restarted under its live calls.
   */
  overloaded: () => boolean;
  /** /api/session, /api/config and CORS for /api (session gate). */
  session?: Router;
  /** Mounts feature routes (public API, admin API) before the 404 handler. */
  routes?: (app: Express) => void;
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

  // One store ping at a time: concurrent /readyz hits share it, so a burst
  // costs the store a single command.
  let ready: Promise<void> | undefined;
  app.get("/readyz", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (deps.overloaded()) return void res.status(503).json({ status: "overloaded" });
    ready ??= withTimeout(deps.store.ping(), deps.readyTimeoutMs ?? 1000).finally(() => {
      ready = undefined;
    });
    try {
      await ready;
      res.json({ status: "ready" });
    } catch (err) {
      deps.logger.warn({ err }, "readiness check failed");
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.get("/metrics", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!deps.metricsToken && deps.metricsRequireToken) return void res.status(404).json({ error: "not_found" });
    if (deps.metricsToken && !tokenMatches(req.get("authorization"), deps.metricsToken)) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
      return;
    }
    res.set("Content-Type", deps.registry.contentType).send(await deps.registry.metrics());
  });

  if (deps.session) app.use(deps.session);
  deps.routes?.(app);

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
