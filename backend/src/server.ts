/**
 * Wires config, store, HTTP and Socket.IO into one server. index.ts calls it
 * for production; tests call it with short timers and listen on port 0.
 */
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { Config } from "./config";
import { createApp } from "./http/app";
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
}

export interface ChizzyServer {
  httpServer: HttpServer;
  io: AppServer;
  service: MatchService;
  metrics: Metrics;
  /** Starts listening; resolves with the bound port (use 0 for a random port). */
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
  const metrics = createMetrics(store);
  const app = createApp({ store, registry: metrics.registry, logger, metricsToken: config.metricsToken });
  const httpServer = createHttpServer(app);
  const io = createSocketServer(httpServer, config);
  deps.configureIo?.(io);

  const service = new MatchService({ store, config, logger, metrics, emitter: createEmitter(io) });
  attachHandlers(io, { config, service, logger, metrics });
  service.start();

  let closing: Promise<void> | undefined;
  return {
    httpServer,
    io,
    service,
    metrics,
    listen(port, host) {
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
