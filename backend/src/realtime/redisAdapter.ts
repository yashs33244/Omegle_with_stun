/**
 * Socket.IO Redis adapter: makes io.to(socketId).emit() and
 * io.in(socketId).disconnectSockets() reach sockets on every instance.
 * It needs its own publish and subscribe connections (a subscribed
 * connection cannot run other commands).
 */
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import type { Logger } from "../logger";
import { REDIS_CLIENT_OPTIONS } from "../store/RedisStore";
import type { AppServer } from "./socket";

export interface RedisAdapterHandle {
  /** Installs the adapter on io; call before any client connects. */
  install(io: AppServer): void;
  /** Quits both connections. Call after io.close(). */
  close(): Promise<void>;
}

/**
 * Connects the pub and sub clients; rejects if Redis is unreachable.
 * `key` prefixes the pub/sub channels (tests pass a unique one).
 */
export async function connectRedisAdapter(
  url: string,
  logger: Logger,
  key = "chizzy:socket.io",
): Promise<RedisAdapterHandle> {
  const pub = new Redis(url, REDIS_CLIENT_OPTIONS);
  const sub = pub.duplicate();
  pub.on("error", (err) => logger.warn({ err, client: "pub" }, "redis adapter connection error"));
  sub.on("error", (err) => logger.warn({ err, client: "sub" }, "redis adapter connection error"));
  try {
    await Promise.all([pub.connect(), sub.connect()]);
  } catch (err) {
    pub.disconnect();
    sub.disconnect();
    throw err;
  }
  return {
    install(io) {
      io.adapter(createAdapter(pub, sub, { key }));
    },
    async close() {
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}
