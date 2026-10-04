/**
 * Shared virtual user for the load test (loadtest.ts) and the synthetic canary
 * (canary.ts). Speaks protocol v3 exactly as the SPA does:
 *
 *   POST /api/session -> socket handshake (auth.sessionToken, websocket only)
 *   -> session:hello -> queue:waiting -> match:found -> accept (preview) or the
 *   server accepts (instant) -> call:start -> rtc:signal offer/answer and
 *   candidate ping-pong -> chat:send -> call:skip -> re-queued by the server.
 *
 * No media is sent: the server only relays signaling, so fake SDP strings are
 * enough to load it. Runs on Node 22 with type stripping; protocol types are
 * imported type-only, so nothing from the backend is loaded at runtime except
 * socket.io-client (resolved from backend/node_modules).
 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  HelloPayload,
  MatchMode,
  PublicConfig,
  ServerToClientEvents,
  SessionRequest,
  SessionResponse,
  Topic,
} from "../../backend/src/protocol.ts";

const require = createRequire(new URL("../../backend/package.json", import.meta.url));
const { io } = require("socket.io-client") as typeof import("socket.io-client");

/** Must equal protocol.ts PROTOCOL_VERSION; the typecheck fails if it drifts. */
export const PROTOCOL_VERSION: HelloPayload["protocolVersion"] = 3;

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface UserOptions {
  /** API origin, for example https://chizzyapi.example.com or http://127.0.0.1:3004. */
  url: string;
  /** POST /api/session before connecting. Off for a backend without the session gate. */
  session: boolean;
  /** ToS version to accept (from GET /api/config). */
  tosVersion: string;
  /** Turnstile token sent with the session request (test keys accept any token). */
  turnstileToken?: string;
  mode: MatchMode;
  language: string;
  /** "any" or a language the partner must speak (a hard filter on the server). */
  languageFilter: string;
  topics: Topic[];
  /** Candidate ping-pong round trips per call (after the offer/answer). */
  signalRoundTrips: number;
  /** How long the initiator stays in the call before pressing Next. */
  holdMs: number;
  /** Stop after this many completed calls (0 = until stopped). */
  maxCalls: number;
  connectTimeoutMs: number;
  /** Instant mode: accept by hand if call:start has not arrived after this long. */
  instantFallbackMs: number;
}

/** Latency samples, counters and error counts, shared by every user. */
export class Stats {
  readonly samples = new Map<string, number[]>();
  readonly counters = new Map<string, number>();
  readonly errors = new Map<string, number>();

  add(name: string, ms: number): void {
    let list = this.samples.get(name);
    if (!list) this.samples.set(name, (list = []));
    list.push(ms);
  }

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  err(code: string): void {
    this.errors.set(code, (this.errors.get(code) ?? 0) + 1);
  }

  count(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  totalErrors(): number {
    let n = 0;
    for (const v of this.errors.values()) n += v;
    return n;
  }

  latencies(): Array<{ name: string; n: number; p50: number; p95: number; p99: number; max: number }> {
    const out = [];
    for (const [name, values] of this.samples) {
      const sorted = [...values].sort((a, b) => a - b);
      out.push({
        name,
        n: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1] ?? 0,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[i] * 10) / 10;
}

/** GET /api/config, or null when the backend does not serve it yet. */
export async function fetchConfig(url: string): Promise<PublicConfig | null> {
  try {
    const res = await fetch(new URL("/api/config", url), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as PublicConfig;
  } catch {
    return null;
  }
}

export class SessionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`session refused: ${code}`);
    this.code = code;
  }
}

/** POST /api/session for a fresh adult device. Returns the session token. */
export async function createSession(opts: UserOptions, deviceId: string): Promise<string> {
  const body: SessionRequest = {
    deviceId,
    // Random per virtual user, so lockouts and bans never collide across users.
    fingerprint: createHash("sha256").update(deviceId).digest("hex"),
    ...(opts.turnstileToken ? { turnstileToken: opts.turnstileToken } : {}),
    age: { dob: "1990-01-01", attest18: true, tosVersion: opts.tosVersion },
  };
  const res = await fetch(new URL("/api/session", opts.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.connectTimeoutMs),
  });
  let data: SessionResponse | undefined;
  try {
    data = (await res.json()) as SessionResponse;
  } catch {
    throw new SessionError(`http_${res.status}`);
  }
  if (!data.ok) throw new SessionError(data.error);
  return data.sessionToken;
}

export interface UserEvents {
  /** call:start arrived for this user. */
  onCallStart?: (user: VirtualUser, roomId: string) => void;
  /** A fatal error stopped this user. */
  onFatal?: (user: VirtualUser, code: string) => void;
}

const PING = "lt-ping";
const PONG = "lt-pong";

/** One simulated person. start() runs the flow until maxCalls or stop(). */
export class VirtualUser {
  readonly deviceId = randomUUID();
  callsCompleted = 0;
  connected = false;
  private socket?: AppSocket;
  private stopped = false;
  private queuedAt?: number;
  private room?: { id: string; foundAt: number; started: boolean; initiator: boolean; offerAt?: number; fallback?: ReturnType<typeof setTimeout>; hold?: ReturnType<typeof setTimeout> };

  readonly index: number;
  private readonly opts: UserOptions;
  private readonly stats: Stats;
  private readonly events: UserEvents;

  // No parameter properties: Node's type stripping only removes erasable syntax.
  constructor(index: number, opts: UserOptions, stats: Stats, events: UserEvents = {}) {
    this.index = index;
    this.opts = opts;
    this.stats = stats;
    this.events = events;
  }

  async start(): Promise<void> {
    const { opts, stats } = this;
    let token: string | undefined;
    if (opts.session) {
      const t0 = performance.now();
      try {
        token = await createSession(opts, this.deviceId);
      } catch (err) {
        return this.fatal(err instanceof SessionError ? `session:${err.code}` : `session:${errorName(err)}`);
      }
      stats.add("session_ms", performance.now() - t0);
    }

    const t0 = performance.now();
    const socket: AppSocket = io(opts.url, {
      transports: ["websocket"],
      auth: token ? { sessionToken: token } : undefined,
      reconnection: false,
      forceNew: true,
      timeout: opts.connectTimeoutMs,
    });
    this.socket = socket;
    this.attach(socket);

    const ok = await new Promise<boolean>((resolve) => {
      socket.once("connect", () => resolve(true));
      socket.once("connect_error", (err: Error & { data?: { code?: string } }) => {
        this.fatal(`connect:${err.data?.code ?? err.message}`);
        resolve(false);
      });
    });
    if (!ok || this.stopped) return;
    this.connected = true;
    stats.add("connect_ms", performance.now() - t0);
    stats.inc("connected");

    const hello: HelloPayload = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: this.deviceId,
      profile: {
        name: `lt${this.index}`,
        country: "IN",
        language: opts.language,
        gender: "unspecified",
        topics: opts.topics,
      },
      preferences: { genderFilter: "all", languageFilter: opts.languageFilter },
      mode: opts.mode,
    };
    const h0 = performance.now();
    this.queuedAt = Date.now();
    socket.emit("session:hello", hello, (res) => {
      if (!res.ok) return this.fatal(`hello:${res.error}`);
      stats.add("hello_ack_ms", performance.now() - h0);
    });
  }

  stop(): void {
    this.stopped = true;
    this.clearRoom();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }
    this.connected = false;
  }

  private fatal(code: string): void {
    this.stats.err(code);
    this.events.onFatal?.(this, code);
    this.stop();
  }

  private clearRoom(): void {
    if (this.room?.fallback) clearTimeout(this.room.fallback);
    if (this.room?.hold) clearTimeout(this.room.hold);
    this.room = undefined;
  }

  private attach(socket: AppSocket): void {
    const { stats, opts } = this;

    socket.on("queue:waiting", () => {
      this.queuedAt ??= Date.now();
    });

    socket.on("match:found", (p) => {
      if (this.queuedAt !== undefined) stats.add("match_ms", Date.now() - this.queuedAt);
      this.queuedAt = undefined;
      stats.inc("matches");
      this.clearRoom();
      this.room = { id: p.roomId, foundAt: performance.now(), started: false, initiator: false };
      if (p.mode === "preview") {
        socket.emit("match:accept", { roomId: p.roomId });
      } else {
        // Instant: the server accepts for us. Accept by hand only if it did
        // not (a backend without instant mode), and count it.
        const roomId = p.roomId;
        this.room.fallback = setTimeout(() => {
          if (this.room?.id === roomId && !this.room.started) {
            stats.inc("instant_fallback_accepts");
            socket.emit("match:accept", { roomId });
          }
        }, opts.instantFallbackMs);
      }
    });

    socket.on("call:start", (p) => {
      const room = this.room;
      if (!room || room.id !== p.roomId) return;
      room.started = true;
      room.initiator = p.initiator;
      stats.add("found_to_call_start_ms", performance.now() - room.foundAt);
      stats.inc("call_starts");
      this.events.onCallStart?.(this, p.roomId);
      if (p.initiator) {
        room.offerAt = performance.now();
        socket.emit("rtc:signal", { roomId: p.roomId, description: { type: "offer", sdp: `v=0 loadtest ${Date.now()}` } });
      }
    });

    socket.on("rtc:signal", (s) => {
      const room = this.room;
      if (!room || room.id !== s.roomId) return;
      if (s.description?.type === "offer") {
        socket.emit("rtc:signal", { roomId: s.roomId, description: { type: "answer", sdp: "v=0 loadtest answer" } });
        return;
      }
      if (s.description?.type === "answer" && room.offerAt !== undefined) {
        stats.add("offer_answer_ms", performance.now() - room.offerAt);
        this.ping(1);
        return;
      }
      const text = s.candidate?.candidate ?? "";
      const [kind, seqText, sentText] = text.split(" ");
      if (kind === PING) {
        socket.emit("rtc:signal", { roomId: s.roomId, candidate: { candidate: `${PONG} ${seqText} ${sentText}`, sdpMid: "0", sdpMLineIndex: 0 } });
      } else if (kind === PONG) {
        stats.add("signal_rtt_ms", performance.now() - Number(sentText));
        const seq = Number(seqText);
        if (seq < opts.signalRoundTrips) this.ping(seq + 1);
        else this.chatThenSkip();
      }
    });

    socket.on("chat:message", () => stats.inc("chat_received"));

    socket.on("match:ended", (p) => {
      const room = this.room;
      if (room && room.id === p.roomId && room.started) {
        this.callsCompleted += 1;
        stats.inc("calls_completed_sides");
      }
      stats.inc(`ended:${p.reason}`);
      this.clearRoom();
      this.queuedAt = Date.now();
      if (opts.maxCalls > 0 && this.callsCompleted >= opts.maxCalls) this.stop();
    });

    socket.on("server:error", (p) => stats.err(`server:${p.code}`));
    socket.on("session:replaced", () => stats.err("session:replaced"));
    socket.on("session:restricted", () => stats.err("session:restricted"));
    socket.on("matching:status", (p) => {
      if (!p.open) stats.inc("matching_closed_notices");
    });
    socket.on("disconnect", (reason) => {
      if (!this.stopped) {
        this.connected = false;
        this.fatal(`disconnect:${reason}`);
      }
    });
  }

  /** Candidate ping carrying its send time (performance.now()) for the round trip. */
  private ping(seq: number): void {
    const room = this.room;
    if (!room || !this.socket) return;
    this.socket.emit("rtc:signal", {
      roomId: room.id,
      candidate: { candidate: `${PING} ${seq} ${performance.now()}`, sdpMid: "0", sdpMLineIndex: 0 },
    });
  }

  /** Initiator only: one chat line (acked), then Next after holdMs. */
  private chatThenSkip(): void {
    const room = this.room;
    const socket = this.socket;
    if (!room || !socket) return;
    const c0 = performance.now();
    socket.emit("chat:send", { roomId: room.id, text: "hi from the load test" }, (res) => {
      if (res.ok) this.stats.add("chat_ack_ms", performance.now() - c0);
      else this.stats.err(`chat:${res.error}`);
    });
    room.hold = setTimeout(() => {
      if (this.room?.id === room.id) socket.emit("call:skip");
    }, this.opts.holdMs);
  }
}

function errorName(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" ? "timeout" : err.message.slice(0, 60);
  return "unknown";
}
