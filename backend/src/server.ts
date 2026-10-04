/**
 * Wires config, store, HTTP and Socket.IO into one server. index.ts calls it
 * for production; tests call it with short timers and listen on port 0.
 */
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type Redis from "ioredis";
import type { Config } from "./config";
import { FlagsReader, MemoryFlagsStore, type FlagsStore } from "./flags/flags";
import { createApp } from "./http/app";
import type { Logger } from "./logger";
import { MatchService } from "./match/MatchService";
import { createMetrics, type Metrics } from "./metrics";
import { MemorySignalStore, RedisSignalStore, SafetySignals } from "./safety/signals";
import type { FetchFn } from "./turn/cloudflare";
import { TurnSpendPoller, cloudflareEgressQuery } from "./turn/spendPoller";
import { MemoryTurnStore, RedisTurnStore } from "./turn/store";
import { TurnService } from "./turn/TurnService";
import { attachHandlers, createEmitter, createSocketServer, type AppServer } from "./realtime/socket";
import { createSessionFeature, sessionWarnings, type RestrictionChecker } from "./session";
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
  /**
   * Outbound HTTP for Turnstile Siteverify and Cloudflare (TURN credentials,
   * analytics). Tests inject a fake; defaults to global fetch.
   */
  fetch?: FetchFn;
  /** Active restriction lookup for POST /api/session (enforcement lane). No-op when unset. */
  restrictions?: RestrictionChecker;
}

export interface ChizzyServer {
  httpServer: HttpServer;
  io: AppServer;
  service: MatchService;
  metrics: Metrics;
  flags: FlagsReader;
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
  const session = createSessionFeature({
    config,
    flags,
    store,
    logger,
    registry: metrics.registry,
    redis: deps.redis,
    fetch: deps.fetch,
    restrictions: deps.restrictions,
  });
  for (const warning of sessionWarnings(config)) logger.warn(`SESSION GATE WARNING: ${warning}`);
  const app = createApp({
    store,
    registry: metrics.registry,
    logger,
    metricsToken: config.metricsToken,
    session: session.router,
  });
  const httpServer = createHttpServer(app);
  const io = createSocketServer(httpServer, config);
  deps.configureIo?.(io);

  const turn = new TurnService({
    config,
    flags,
    logger,
    metrics,
    store: deps.redis ? new RedisTurnStore(deps.redis) : new MemoryTurnStore(),
    fetch: deps.fetch,
  });
  const safety = new SafetySignals({
    config,
    logger,
    metrics,
    store: deps.redis ? new RedisSignalStore(deps.redis) : new MemorySignalStore(),
  });
  const spendPoller =
    config.cfAccountId && config.cfAnalyticsToken
      ? new TurnSpendPoller({
          flags,
          logger,
          metrics,
          redis: deps.redis,
          thresholdsGb: config.turnSpendDailyGb,
          intervalMs: config.turnSpendPollMs,
          query: cloudflareEgressQuery({
            accountId: config.cfAccountId,
            apiToken: config.cfAnalyticsToken,
            fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
          }),
        })
      : undefined;
  const service = new MatchService({
    store,
    config,
    logger,
    metrics,
    flags,
    turn,
    safety,
    emitter: createEmitter(io),
    gate: session.gate,
  });
  attachHandlers(io, {
    config,
    service,
    logger,
    metrics,
    handshake: config.requireSession ? session.handshake : undefined,
  });
  const stopBroadcast = session.startBroadcast(io);
  // listen() waits for this, so no client connects before the first heartbeat.
  const started = flags.start().then(() => {
    spendPoller?.start();
    return service.start();
  });
  started.catch(() => {}); // surfaced by listen(); avoid an unhandled rejection meanwhile

  let closing: Promise<void> | undefined;
  return {
    httpServer,
    io,
    service,
    metrics,
    flags,
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
        stopBroadcast();
        spendPoller?.stop();
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
