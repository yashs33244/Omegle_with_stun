/**
 * Process bootstrap: config, store, server, signal handling. No domain logic here.
 */
import { ConfigError, loadConfig, type Config } from "./config";
import { createLogger } from "./logger";
import { createServer } from "./server";
import { MemoryStore } from "./store/MemoryStore";
import type { MatchStore } from "./store/MatchStore";

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(config.logLevel, config.instanceId);

  let store: MatchStore;
  if (config.redisUrl) {
    // RedisStore is added by the backend-redis lane; until then refuse to
    // pretend we share state across replicas.
    logger.fatal("REDIS_URL is set but this build has no Redis store");
    process.exit(1);
  } else {
    store = new MemoryStore();
    logger.info("using in-memory store (single instance)");
  }

  const server = createServer(config, { store, logger });
  const port = await server.listen(config.port);
  logger.info({ port, env: config.nodeEnv }, "listening");

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      logger.error("shutdown grace period exceeded, exiting");
      process.exit(1);
    }, config.shutdownGraceMs);
    force.unref();
    server
      .close()
      .then(() => store.close())
      .then(
        () => {
          logger.info("shutdown complete");
          process.exit(0);
        },
        (err: unknown) => {
          logger.error({ err }, "shutdown failed");
          process.exit(1);
        },
      );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
