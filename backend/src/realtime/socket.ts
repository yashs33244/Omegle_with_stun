/**
 * Socket.IO server: transport limits, per-IP connection cap, per-socket rate
 * limits and the safe() wrapper that validates every payload and guarantees a
 * handler can never throw out of an event listener.
 */
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { ZodType } from "zod";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { Metrics } from "../metrics";
import type { Emitter, MatchService } from "../match/MatchService";
import {
  PROTOCOL_VERSION,
  chatSendSchema,
  chatTypingSchema,
  helloSchema,
  reportSchema,
  roomRefSchema,
  rtcSignalSchema,
  updatePreferencesSchema,
  type ClientToServerEvents,
  type ErrorCode,
  type ServerToClientEvents,
} from "../protocol";
import { SocketRateLimiter, type EventClass } from "../rateLimit";
import { limitedParser } from "./limitedParser";

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export const MAX_HTTP_BUFFER_SIZE = 256 * 1024;

/** Client IP: X-Real-IP from our gateway when TRUST_PROXY is on, else the TCP peer. */
export function clientIp(socket: Pick<AppSocket, "handshake">, trustProxy: boolean): string {
  if (trustProxy) {
    const header = socket.handshake.headers["x-real-ip"];
    const value = Array.isArray(header) ? header[0] : header;
    if (value && value.trim()) return value.trim();
  }
  return socket.handshake.address;
}

/**
 * Browsers do not apply CORS to WebSocket upgrades, so the allowlist is also
 * checked on every handshake. Requests without an Origin header come from
 * non-browser clients, which can send any Origin anyway, and are allowed.
 */
export function originAllowed(origin: string | undefined, allowed: Config["corsOrigins"]): boolean {
  return allowed === "*" || origin === undefined || allowed.includes(origin);
}

export function createSocketServer(httpServer: HttpServer, config: Config): AppServer {
  return new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: config.corsOrigins === "*" ? "*" : config.corsOrigins, methods: ["GET", "POST"] },
    allowRequest: (req, callback) => callback(null, originAllowed(req.headers.origin, config.corsOrigins)),
    maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
    parser: limitedParser(MAX_HTTP_BUFFER_SIZE),
    pingInterval: 20_000,
    pingTimeout: 20_000,
    connectTimeout: 10_000,
  });
}

/** Emits by socket id through io.to(), so it also reaches sockets on other instances. */
export function createEmitter(io: AppServer): Emitter {
  return {
    emit(socketId, event, ...args) {
      // The generic event map cannot be narrowed through the rest parameter.
      (io.to(socketId).emit as (ev: string, ...a: unknown[]) => boolean)(event, ...args);
    },
    disconnect(socketId) {
      io.in(socketId).disconnectSockets(true);
    },
    isLocalConnected(socketId) {
      return io.sockets.sockets.get(socketId)?.connected ?? false;
    },
  };
}

interface AttachDeps {
  config: Config;
  service: MatchService;
  logger: Logger;
  metrics: Metrics;
  /** Injectable for tests. */
  newRateLimiter?: () => SocketRateLimiter;
}

export function attachHandlers(io: AppServer, deps: AttachDeps): void {
  const { config, service, logger, metrics } = deps;
  const newRateLimiter = deps.newRateLimiter ?? (() => new SocketRateLimiter());
  const perIp = new Map<string, number>();

  io.use((socket, next) => {
    const ip = clientIp(socket, config.trustProxy);
    const count = perIp.get(ip) ?? 0;
    if (count >= config.maxConnectionsPerIp) {
      metrics.rateLimitedTotal.inc({ event: "connection" });
      return next(new Error("too_many_connections"));
    }
    perIp.set(ip, count + 1);
    // Release on the underlying connection's close, which fires even when the
    // client drops between this middleware and the "connection" event.
    socket.conn.once("close", () => {
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
    });
    next();
  });

  io.on("connection", (socket: AppSocket) => {
    metrics.connectedSockets.inc();
    const limiter = newRateLimiter();
    const log = logger.child({ socketId: socket.id });
    log.debug("connected");

    const fail = (event: string, code: ErrorCode, ack?: (res: unknown) => void, message?: string) => {
      if (ack) ack({ ok: false, error: code, ...(message ? { message } : {}) });
      else socket.emit("server:error", { code, ...(message ? { message } : {}) });
      log.debug({ event, code }, "event rejected");
    };

    /**
     * Registers one validated, rate limited handler. `reply` sends the ack at
     * most once (and is a no-op when the client sent no ack callback). If the
     * handler throws before replying, the client gets `internal`.
     */
    function on<T>(
      event: keyof ClientToServerEvents,
      cls: EventClass,
      schema: ZodType<T> | null,
      handler: (data: T, reply: (res: unknown) => void) => Promise<void>,
    ): void {
      socket.on(event, (...args: unknown[]) => {
        const last = args[args.length - 1];
        const ack = typeof last === "function" ? (last as (res: unknown) => void) : undefined;
        const raw = ack ? args.slice(0, -1)[0] : args[0];
        let replied = false;
        const onError = (err: unknown) => {
          metrics.handlerErrorsTotal.inc({ event });
          log.error({ err, event }, "handler failed");
          if (!replied) {
            replied = true;
            fail(event, "internal", ack);
          }
        };
        try {

          if (!limiter.allow(cls)) {
            metrics.rateLimitedTotal.inc({ event });
            return fail(event, "rate_limited", ack);
          }
          let data: T;
          if (schema) {
            if (event === "session:hello" && isWrongVersion(raw)) {
              return fail(event, "unsupported_version", ack, `protocolVersion must be ${PROTOCOL_VERSION}`);
            }
            const parsed = schema.safeParse(raw);
            if (!parsed.success) {
              metrics.invalidPayloadTotal.inc({ event });
              return fail(event, "invalid_payload", ack);
            }
            data = parsed.data;
          } else {
            data = undefined as T;
          }

          const reply = (res: unknown) => {
            if (replied) return;
            replied = true;
            ack?.(res);
          };
          handler(data, reply).catch(onError);
        } catch (err) {
          onError(err);
        }
      });
    }

    on("session:hello", "hello", helloSchema, (p, reply) => service.hello(socket.id, p, reply));
    on("session:preferences", "preferences", updatePreferencesSchema, (p, reply) =>
      service.updatePreferences(socket.id, p, reply),
    );
    on("match:accept", "control", roomRefSchema, (p) => service.accept(socket.id, p.roomId));
    on("match:decline", "control", roomRefSchema, (p) => service.decline(socket.id, p.roomId));
    on("call:skip", "control", null, () => service.skip(socket.id));
    on("rtc:signal", "signal", rtcSignalSchema, (p) => service.signal(socket.id, p));
    on("chat:send", "chat", chatSendSchema, (p, reply) => service.chat(socket.id, p, reply));
    on("chat:typing", "typing", chatTypingSchema, (p) => service.typing(socket.id, p));
    on("report:submit", "report", reportSchema, (p, reply) => service.report(socket.id, p, reply));

    socket.on("disconnect", (reason) => {
      metrics.connectedSockets.dec();
      log.debug({ reason }, "disconnected");
      service.disconnect(socket.id).catch((err: unknown) => {
        metrics.handlerErrorsTotal.inc({ event: "disconnect" });
        log.error({ err }, "disconnect cleanup failed");
      });
    });
  });
}

function isWrongVersion(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "protocolVersion" in raw &&
    (raw as { protocolVersion: unknown }).protocolVersion !== PROTOCOL_VERSION
  );
}
