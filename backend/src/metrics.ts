/**
 * Prometheus metrics. Each server gets its own registry so several servers
 * can run in one process (tests) without clashing on metric names.
 */
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import type { MatchStore } from "./store/MatchStore";

export interface Metrics {
  registry: Registry;
  connectedSockets: Gauge;
  matchesTotal: Counter;
  matchEndTotal: Counter<"reason">;
  rateLimitedTotal: Counter<"event">;
  invalidPayloadTotal: Counter<"event">;
  handlerErrorsTotal: Counter<"event">;
}

export function createMetrics(store: MatchStore): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const connectedSockets = new Gauge({
    name: "chizzy_connected_sockets",
    help: "Socket.IO connections on this instance",
    registers: [registry],
  });

  // Store-wide gauges, read from the store at scrape time.
  const storeGauge = (name: string, help: string, pick: (s: Awaited<ReturnType<MatchStore["stats"]>>) => number) =>
    new Gauge({
      name,
      help,
      registers: [registry],
      async collect() {
        try {
          this.set(pick(await store.stats()));
        } catch {
          // Store unreachable: keep the last value; /readyz reports the outage.
        }
      },
    });
  storeGauge("chizzy_sessions", "Sessions that sent session:hello", (s) => s.sessions);
  storeGauge("chizzy_waiting_sessions", "Sessions waiting for a match", (s) => s.waiting);
  storeGauge("chizzy_pending_rooms", "Matches waiting for both accepts", (s) => s.pendingRooms);
  storeGauge("chizzy_active_rooms", "Rooms with a call in progress", (s) => s.activeRooms);

  return {
    registry,
    connectedSockets,
    matchesTotal: new Counter({ name: "chizzy_matches_total", help: "Matches created", registers: [registry] }),
    matchEndTotal: new Counter({
      name: "chizzy_match_end_total",
      help: "Rooms ended, by reason",
      labelNames: ["reason"],
      registers: [registry],
    }),
    rateLimitedTotal: new Counter({
      name: "chizzy_rate_limited_total",
      help: "Events rejected by the per-socket rate limiter",
      labelNames: ["event"],
      registers: [registry],
    }),
    invalidPayloadTotal: new Counter({
      name: "chizzy_invalid_payload_total",
      help: "Events rejected by schema validation",
      labelNames: ["event"],
      registers: [registry],
    }),
    handlerErrorsTotal: new Counter({
      name: "chizzy_handler_errors_total",
      help: "Unexpected errors inside event handlers",
      labelNames: ["event"],
      registers: [registry],
    }),
  };
}
