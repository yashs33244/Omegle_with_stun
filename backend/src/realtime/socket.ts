/**
 * Socket.IO server: transport limits, instance-wide shedding, per-IP
 * connection cap and connection rate, per-session socket cap, the hello
 * deadline, per-socket rate limits
 * and the safe() wrapper that validates every payload and guarantees a
 * handler can never throw out of an event listener.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { ZodType } from "zod";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { Metrics } from "../metrics";
import type { Emitter, MatchService } from "../match/MatchService";
import type { CaptionRelay } from "../captions/CaptionRelay";
import type { SparkService } from "../spark/SparkService";
import { captureError } from "../observability/sentry";
import {
  PROTOCOL_VERSION,
  callFailedSchema,
  callTelemetrySchema,
  captionSegmentSchema,
  chatSendSchema,
  chatTypingSchema,
  helloSchema,
  moderationSignalSchema,
  reportSchema,
  callSkipSchema,
  roomRefSchema,
  rtcSignalSchema,
  sparkRequestSchema,
  updatePreferencesSchema,
  type ClientToServerEvents,
  type ErrorCode,
  type ServerToClientEvents,
} from "../protocol";
import { MAX_SOCKETS_PER_SESSION, SocketRateLimiter, TokenBucket, type EventClass } from "../rateLimit";
import { requestIp, socketIp } from "../session/geo";
import { handshakeSession } from "../session/handshake";
import { refuseUpgrade, type Shedder } from "../shed/Shedder";
import { limitedParser } from "./limitedParser";

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export const MAX_HTTP_BUFFER_SIZE = 256 * 1024;

/**
 * Browsers do not apply CORS to WebSocket upgrades, so the allowlist is also
 * checked on every handshake. Requests without an Origin header come from
 * non-browser clients, which can send any Origin anyway, and are allowed.
 */
export function originAllowed(origin: string | undefined, allowed: Config["corsOrigins"]): boolean {
  return allowed === "*" || origin === undefined || allowed.includes(origin);
}

/** A refused upgrade: the string is the handshake error message and the metric label. */
export type ConnectionRefusal = "too_many_connections" | "rate_limited";

/**
 * Per-IP connection cap and connect rate, checked in allowRequest, i.e. on
 * the HTTP upgrade before any Engine.IO connection or Socket.IO client
 * exists. A refusal there is a plain HTTP 400 whose body names the reason
 * and costs nothing after it (the Socket.IO client only sees "websocket error"); a
 * namespace middleware refusal would leave the client's connection open for
 * connectTimeout and run the session gate (a store write) first.
 *
 * Open connections are counted from the engine's "connection" event, which
 * ws fires in the same tick as allowRequest, so a burst from one address
 * cannot slip past the cap between the check and the count.
 */
export class ConnectionGate {
  private readonly perIp = new Map<string, number>();
  private readonly connectRate = new Map<string, TokenBucket>();
  private lastPrune: number;

  constructor(
    private readonly config: Pick<Config, "maxConnectionsPerIp" | "connectRatePerIp">,
    private readonly metrics: Pick<Metrics, "rateLimitedTotal">,
    private readonly now: () => number = Date.now,
  ) {
    this.lastPrune = now();
  }

  /** Why a new connection from `ip` is refused, or null to let it through. */
  admit(ip: string): ConnectionRefusal | null {
    if ((this.perIp.get(ip) ?? 0) >= this.config.maxConnectionsPerIp) {
      this.metrics.rateLimitedTotal.inc({ event: "connection" });
      return "too_many_connections";
    }
    // Per-socket buckets start full, so new connections per IP are rate
    // limited too; otherwise reconnecting would refill every bucket.
    const now = this.now();
    // Drop refilled buckets so the map only holds recently seen addresses.
    if (now - this.lastPrune >= 60_000) {
      this.lastPrune = now;
      for (const [key, bucket] of this.connectRate) if (bucket.full(now)) this.connectRate.delete(key);
    }
    let bucket = this.connectRate.get(ip);
    if (!bucket) {
      bucket = new TokenBucket(this.config.connectRatePerIp, now);
      this.connectRate.set(ip, bucket);
    }
    if (!bucket.take(now)) {
      this.metrics.rateLimitedTotal.inc({ event: "connection_rate" });
      return "rate_limited";
    }
    return null;
  }

  opened(ip: string): void {
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
  }

  closed(ip: string): void {
    const left = (this.perIp.get(ip) ?? 1) - 1;
    if (left <= 0) this.perIp.delete(ip);
    else this.perIp.set(ip, left);
  }
}

/**
 * `shed` runs first: while the instance sheds (overload, MAX_CONNECTIONS_TOTAL)
 * the upgrade is answered 503 before any per-IP bucket is charged. The
 * instance-wide count is the engine's own clientsCount, which counts every
 * open Engine.IO connection, with or without a Socket.IO session yet.
 */
export function createSocketServer(httpServer: HttpServer, config: Config, gate: ConnectionGate, shed: Shedder): AppServer {
  const io: AppServer = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: config.corsOrigins === "*" ? "*" : config.corsOrigins, methods: ["GET", "POST"] },
    allowRequest: (req, callback) => {
      if (!originAllowed(req.headers.origin, config.corsOrigins)) return callback("origin not allowed", false);
      const shedding = shed.admitSocket(io.engine.clientsCount);
      if (shedding) {
        // allowRequest only runs for a websocket handshake, so req.socket is
        // the raw upgrade socket; the engine's own 400 then finds it destroyed.
        refuseUpgrade(req.socket, shedding);
        return callback(shedding, false);
      }
      const refused = gate.admit(requestIp(req.headers, req.socket.remoteAddress, config.proxyIpHeader));
      callback(refused, refused === null);
    },
    // WebSocket only: long polling would let one client hold HTTP request
    // slots and an Engine.IO session without an open socket (the gateway only
    // proxies websocket upgrades anyway; the SPA connects with transports: ["websocket"]).
    transports: ["websocket"],
    maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
    parser: limitedParser(MAX_HTTP_BUFFER_SIZE),
    pingInterval: 20_000,
    pingTimeout: 20_000,
    connectTimeout: 10_000,
  });
  io.engine.on("connection", (conn: { request: IncomingMessage; on(event: "close", fn: () => void): void }) => {
    const ip = requestIp(conn.request.headers, conn.request.socket.remoteAddress, config.proxyIpHeader);
    gate.opened(ip);
    conn.on("close", () => gate.closed(ip));
  });
  return io;
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
  spark: SparkService;
  captions: CaptionRelay;
  metrics: Metrics;
  /** Injectable for tests. */
  newRateLimiter?: () => SocketRateLimiter;
  /**
   * Session-token gate (src/session/handshake.ts). Runs as the first
   * namespace middleware, after the per-IP cap and connect rate, which
   * ConnectionGate applies in allowRequest on the HTTP upgrade.
   */
  handshake?: Parameters<AppServer["use"]>[0];
}

export interface Handlers {
  /**
   * Resolves once no handler or disconnect cleanup is running. Graceful close
   * awaits it after io.close() so the store is never closed under a cleanup
   * that holds the match lock.
   */
  idle(): Promise<void>;
}

export function attachHandlers(io: AppServer, deps: AttachDeps): Handlers {
  const { config, service, logger, metrics, spark, captions } = deps;
  const newRateLimiter = deps.newRateLimiter ?? (() => new SocketRateLimiter());
  /** Open sockets per session (device id from the handshake token); unused when the gate is off. */
  const perSession = new Map<string, number>();
  const running = new Set<Promise<void>>();
  /** `work` must already handle its own errors. */
  const track = (work: Promise<void>) => {
    running.add(work);
    const done = () => running.delete(work);
    work.then(done, done);
  };

  /**
   * A middleware refusal sends CONNECT_ERROR, but Socket.IO then keeps the
   * connection open for connectTimeout in case the client joins another
   * namespace. Nothing here has one, so close it once the packet is out
   * (Socket.IO sends it on the next tick after `next`).
   */
  const closing = (next: (err?: Error) => void, socket: AppSocket) => (err?: Error) => {
    if (err) process.nextTick(() => setImmediate(() => socket.conn.close()));
    next(err);
  };

  if (deps.handshake) {
    const handshake = deps.handshake;
    io.use((socket, next) => handshake(socket, closing(next, socket)));
  }
  io.use((socket, next) => {
    // One session token is one browser profile: a few tabs at most. More
    // sockets than that is a client holding connections (each hello replaces
    // the previous socket's session anyway, so they would gain nothing legitimate).
    const deviceId = handshakeSession(socket)?.deviceId;
    if (!deviceId) return next();
    // The session gate above awaited a store write; a client that dropped
    // meanwhile has no close event left to fire, so counting it would hold a
    // slot for good. Socket.IO discards the socket after next() anyway.
    if (socket.conn.readyState !== "open") return next();
    const count = perSession.get(deviceId) ?? 0;
    if (count >= MAX_SOCKETS_PER_SESSION) {
      metrics.rateLimitedTotal.inc({ event: "session_connections" });
      return closing(next, socket)(new Error("too_many_connections"));
    }
    perSession.set(deviceId, count + 1);
    // Release on the underlying connection's close, which fires even when the
    // client drops between this middleware and the "connection" event.
    socket.conn.once("close", () => {
      const left = (perSession.get(deviceId) ?? 0) - 1;
      if (left <= 0) perSession.delete(deviceId);
      else perSession.set(deviceId, left);
    });
    next();
  });

  io.on("connection", (socket: AppSocket) => {
    metrics.connectedSockets.inc();
    const limiter = newRateLimiter();
    const log = logger.child({ socketId: socket.id });
    log.debug("connected");
    // A socket that never sends a well-formed session:hello is a client holding
    // a connection for nothing (a scanner, a stalled page): drop it so the slot
    // and the per-IP count go back. The SPA sends hello on connect.
    let helloDeadline: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      helloDeadline = undefined;
      metrics.rateLimitedTotal.inc({ event: "hello_timeout" });
      log.debug("no hello before the deadline");
      socket.disconnect(true);
    }, config.helloTimeoutMs);
    const helloSeen = () => {
      if (!helloDeadline) return;
      clearTimeout(helloDeadline);
      helloDeadline = undefined;
    };

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
          captureError(err, { event });
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
          track(handler(data, reply).catch(onError));
        } catch (err) {
          onError(err);
        }
      });
    }

    on("session:hello", "hello", helloSchema, async (p, reply) => {
      helloSeen();
      const session = handshakeSession(socket);
      if (session && session.deviceId !== p.deviceId) {
        return reply({ ok: false, error: "invalid_payload", message: "deviceId does not match the session token" });
      }
      return service.hello(socket.id, p, reply, socketIp(socket, config.proxyIpHeader));
    });
    on("session:preferences", "preferences", updatePreferencesSchema, (p, reply) =>
      service.updatePreferences(socket.id, p, reply),
    );
    on("match:accept", "control", roomRefSchema, (p) => service.accept(socket.id, p.roomId));
    on("match:decline", "control", roomRefSchema, (p) => service.decline(socket.id, p.roomId));
    on("call:connected", "control", roomRefSchema, (p) => service.connected(socket.id, p.roomId));
    on("call:skip", "control", callSkipSchema, (p) => service.skip(socket.id, p?.roomId));
    on("rtc:signal", "signal", rtcSignalSchema, (p) => service.signal(socket.id, p));
    on("chat:send", "chat", chatSendSchema, (p, reply) => service.chat(socket.id, p, reply));
    on("chat:typing", "typing", chatTypingSchema, (p) => service.typing(socket.id, p));
    on("report:submit", "report", reportSchema, (p, reply) => service.report(socket.id, p, reply, socketIp(socket, config.proxyIpHeader)));
    on("call:failed", "telemetry", callFailedSchema, (p) => service.callFailed(socket.id, p));
    on("call:telemetry", "telemetry", callTelemetrySchema, (p) => service.telemetry(socket.id, p));
    on("moderation:signal", "telemetry", moderationSignalSchema, (p) => service.moderationSignal(socket.id, p));
    on("spark:request", "control", sparkRequestSchema, (p, reply) => spark.request(socket.id, p.roomId, reply));
    // "signal" is the outer bucket; CaptionRelay applies the CAPTIONS.maxPerSec cap itself.
    on("caption:segment", "signal", captionSegmentSchema, (p) => captions.segment(socket.id, p));

    socket.on("disconnect", (reason) => {
      helloSeen();
      metrics.connectedSockets.dec();
      captions.forget(socket.id);
      log.debug({ reason }, "disconnected");
      track(
        service.disconnect(socket.id).catch((err: unknown) => {
          metrics.handlerErrorsTotal.inc({ event: "disconnect" });
          log.error({ err }, "disconnect cleanup failed");
        }),
      );
    });
  });

  return {
    async idle() {
      // Loop in case work was added while waiting.
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
}

function isWrongVersion(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "protocolVersion" in raw &&
    (raw as { protocolVersion: unknown }).protocolVersion !== PROTOCOL_VERSION
  );
}
