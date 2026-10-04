/**
 * Wires config, store, HTTP and Socket.IO into one server. index.ts calls it
 * for production; tests call it with short timers and listen on port 0.
 */
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type Redis from "ioredis";
import type { Config } from "./config";
import { createEnforcement, type EnforcementOptions, type EnforcementService } from "./enforcement";
import { FlagsReader, MemoryFlagsStore, type FlagsStore } from "./flags/flags";
import { adminApiRouter } from "./http/admin";
import { createApp } from "./http/app";
import { publicApiRouter } from "./http/public";
import type { Logger } from "./logger";
import { MatchService } from "./match/MatchService";
import { createMetrics, type Metrics } from "./metrics";
import { attachHandlers, createEmitter, createSocketServer, type AppServer } from "./realtime/socket";
import type { MatchStore } from "./store/MatchStore";

export interface ServerDeps {
  store: MatchStore;
  logger: Logger;
  /** Optional hook to install a cross-instance adapter (Redis) before handlers attach. */
  configureIo?: (io: AppServer) => void;
  /** Operator flags storage. Defaults to memory (single instance, tests). */
  flags?: FlagsStore;
  /**
   * Shared Redis client for feature stores (session, enforcement, ...) in Redis mode.
   * Undefined means single-instance memory mode: feature stores must fall back to memory.
   * The caller owns and closes it.
   */
  redis?: Redis;
  /** Enforcement overrides (stores, Turnstile verifier, classifier) for tests and wiring. */
  enforcement?: EnforcementOptions;
}

export interface ChizzyServer {
  httpServer: HttpServer;
  io: AppServer;
  service: MatchService;
  metrics: Metrics;
  flags: FlagsReader;
  /** Reports, restrictions, appeals, takedowns. Also the session lane's restrictions dependency (activeForDevice). */
  enforcement: EnforcementService;
  /** The deps this server was built with, for feature modules that need the shared Redis client. */
  deps: ServerDeps;
  /**
   * Starts listening once the instance heartbeat is stored; resolves with the
   * bound port (use 0 for a random port). Rejects if the store is unreachable.
   */
  listen(port: number, host?: string): Promise<number>;
  /**
   * Graceful close: ends local sessions (partners are re-queued), tells local
   * clients `server:shutdown`, closes Socket.IO and the HTTP server. The store
   * belongs to the caller and is not closed.
   */
  close(): Promise<void>;
}

export function createServer(config: Config, deps: ServerDeps): ChizzyServer {
  const { store, logger } = deps;
  const flags = new FlagsReader(deps.flags ?? new MemoryFlagsStore());
  const metrics = createMetrics(store);
  const enforcement = createEnforcement(config, { logger, redis: deps.redis }, deps.enforcement);
  const app = createApp({
    store,
    registry: metrics.registry,
    logger,
    metricsToken: config.metricsToken,
    routes: (a) => {
      a.use(publicApiRouter({ enforcement, trustProxy: config.trustProxy, logger }));
      a.use(
        "/admin/api",
        adminApiRouter({
          enforcement,
          flags,
          logger,
          adminToken: config.adminToken,
          adminAllowedIps: config.adminAllowedIps,
          trustProxy: config.trustProxy,
        }),
      );
    },
  });
  const httpServer = createHttpServer(app);
  const io = createSocketServer(httpServer, config);
  deps.configureIo?.(io);

  const service = new MatchService({ store, config, logger, metrics, flags, enforcement, emitter: createEmitter(io) });
  attachHandlers(io, { config, service, logger, metrics });
  // listen() waits for this, so no client connects before the first heartbeat.
  const started = flags
    .start()
    .then(() => service.start())
    .then(() => enforcement.start());
  started.catch(() => {}); // surfaced by listen(); avoid an unhandled rejection meanwhile

  let closing: Promise<void> | undefined;
  return {
    httpServer,
    io,
    service,
    metrics,
    flags,
    enforcement,
    deps,
    async listen(port, host) {
      await started;
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          const address = httpServer.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      });
    },
    close() {
      closing ??= (async () => {
        flags.stop();
        await enforcement.stop();
        try {
          await service.shutdown();
        } catch (err) {
          logger.error({ err }, "service shutdown failed");
        }
        // io.close() disconnects every socket and closes the HTTP server.
        await new Promise<void>((resolve) => {
          io.close(() => resolve());
        });
      })();
      return closing;
    },
  };
}
