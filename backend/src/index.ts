/**
 * Process bootstrap: config, store, server, signal handling. No domain logic here.
 */
import { ConfigError, loadConfig, type Config } from "./config";
import { createLogger } from "./logger";
import Redis from "ioredis";
import { RedisFlagsStore } from "./flags/flags";
import { startKeepalive } from "./keepalive";
import { closeSentry, initSentry } from "./observability/sentry";
import { connectRedisAdapter, type RedisAdapterHandle } from "./realtime/redisAdapter";
import { createServer } from "./server";
import { MemoryStore } from "./store/MemoryStore";
import type { MatchStore } from "./store/MatchStore";
import { RedisStore } from "./store/RedisStore";

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
  if (await initSentry(config)) logger.info("sentry error reporting enabled");

  let store: MatchStore;
  let adapter: RedisAdapterHandle | undefined;
  let appRedis: Redis | undefined;
  if (config.redisUrl) {
    // Shared state and cross-instance emits: safe to run several replicas.
    store = await RedisStore.connect(config.redisUrl, { logger });
    adapter = await connectRedisAdapter(config.redisUrl, logger);
    // Shared client for feature stores (flags, session, enforcement).
    appRedis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2, commandTimeout: 5_000 });
    appRedis.on("error", (err) => logger.warn({ err }, "app redis connection error"));
    await appRedis.connect();
    logger.info("using Redis store and Socket.IO Redis adapter");
  } else {
    store = new MemoryStore();
    logger.info("using in-memory store (single instance)");
  }

  const server = createServer(config, {
    store,
    logger,
    configureIo: adapter?.install,
    redis: appRedis,
    flags: appRedis ? new RedisFlagsStore(appRedis) : undefined,
  });
  const port = await server.listen(config.port);
  logger.info({ port, env: config.nodeEnv }, "listening");
  const stopKeepalive = config.keepaliveUrl ? startKeepalive({ url: config.keepaliveUrl, logger }) : undefined;

  let shuttingDown = false;
  const shutdown = (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    stopKeepalive?.();
    const force = setTimeout(() => {
      logger.error("shutdown grace period exceeded, exiting");
      process.exit(1);
    }, config.shutdownGraceMs);
    force.unref();
    server
      .close()
      .then(() => store.close())
      .then(() => adapter?.close())
      .then(() => appRedis?.quit())
      .then(() => closeSentry())
      .then(
        () => {
          logger.info("shutdown complete");
          process.exit(exitCode);
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
  // Backstop only: socket handlers never throw (see realtime/socket.ts). If
  // something still does, the process state is unknown, so drain and exit.
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception");
    shutdown("uncaughtException", 1);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
