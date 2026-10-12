/**
 * Instance-wide admission for new work: new Engine.IO connections
 * (realtime/socket.ts allowRequest) and POST /api/session (http/session.ts).
 * It refuses when the LoadMonitor says the process is overloaded, when the
 * instance already holds MAX_CONNECTIONS_TOTAL connections, or when the
 * instance-wide session bucket is empty. Work already admitted (open
 * sockets, running calls) is never touched. Every refusal is counted in
 * chizzy_shed_total{reason}.
 */
import type { Socket } from "node:net";
import type { Metrics } from "../metrics";
import { TokenBucket, type BucketSpec } from "../rateLimit";
import { SHED_RETRY_AFTER_SEC } from "./constants";

/** The upgrade refusal body: overloaded (LoadMonitor) or server_full (MAX_CONNECTIONS_TOTAL). */
export type SocketShed = "overloaded" | "server_full";
export type ShedReason = "overload_socket" | "connection_cap" | "overload_session" | "session_rate";

export interface ShedderOptions {
  maxConnectionsTotal: number;
  sessionRateTotal: BucketSpec;
  load: { readonly overloaded: boolean };
  metrics: Pick<Metrics, "shedTotal">;
  now?: () => number;
}

export class Shedder {
  private readonly sessions: TokenBucket;
  private readonly now: () => number;

  constructor(private readonly opts: ShedderOptions) {
    this.now = opts.now ?? Date.now;
    this.sessions = new TokenBucket(opts.sessionRateTotal, this.now());
  }

  get overloaded(): boolean {
    return this.opts.load.overloaded;
  }

  /** Why a new connection is refused while `open` connections exist, or null to admit it. */
  admitSocket(open: number): SocketShed | null {
    if (this.opts.load.overloaded) return this.shed("overload_socket", "overloaded");
    if (open >= this.opts.maxConnectionsTotal) return this.shed("connection_cap", "server_full");
    return null;
  }

  /** False (and counted) while overloaded. Checked before any per-IP bucket is charged. */
  admitSessionLoad(): boolean {
    return !this.opts.load.overloaded || this.shed("overload_session", false);
  }

  /** Takes one token from the instance-wide session bucket; false (and counted) when empty. */
  takeSession(): boolean {
    return this.sessions.take(this.now()) || this.shed("session_rate", false);
  }

  private shed<T>(reason: ShedReason, result: T): T {
    this.opts.metrics.shedTotal.inc({ reason });
    return result;
  }
}

/**
 * Answers a WebSocket upgrade with 503 and closes it. Engine.IO can only
 * answer 400, which reads as a client error; 503 plus Retry-After says
 * "try again later" to anything that looks (browsers do not expose either).
 */
export function refuseUpgrade(socket: Socket, body: SocketShed): void {
  socket.on("error", () => {});
  if (socket.writable) {
    socket.write(
      "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\n" +
        `Retry-After: ${SHED_RETRY_AFTER_SEC}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  }
  socket.destroy();
}
