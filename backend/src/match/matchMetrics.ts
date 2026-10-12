/**
 * Prometheus metrics owned by the matching lane (calls, TURN, safety signals).
 * Created on the server's registry by createMetrics() in metrics.ts.
 * No label ever carries an IP, a device id or chat content.
 */
import { Counter, Gauge, Histogram, type Registry } from "prom-client";

export interface MatchMetrics {
  /** From call:telemetry, one per side per call. */
  callsTotal: Counter<"outcome" | "local_candidate" | "private">;
  timeToConnectSeconds: Histogram;
  callFailedTotal: Counter<"reason">;
  moderationSignalsTotal: Counter<"kind">;
  safetyNudgesTotal: Counter<"kind">;
  chatRedactedTotal: Counter;
  namesReplacedTotal: Counter;
  earlySkipsTotal: Counter;
  lowPriorityTotal: Counter<"cause">;
  /** Devices put on an accept-timeout cooldown (let too many accept windows expire). */
  acceptCooldownsTotal: Counter;
  turnCredentialsTotal: Counter<"result">;
  turnSpendStepsTotal: Counter<"step">;
  turnSpendPollErrorsTotal: Counter;
  /** Times the poller failed SPEND_FAILSAFE_AFTER_FAILURES polls in a row and stepped down blind. */
  turnSpendFailsafeTotal: Counter;
  turnEgressGbToday: Gauge;
}

export function createMatchMetrics(registry: Registry): MatchMetrics {
  const registers = [registry];
  return {
    callsTotal: new Counter({
      name: "chizzy_calls_total",
      help: "Calls reported by call:telemetry (each side reports once), by outcome, local candidate type and private mode",
      labelNames: ["outcome", "local_candidate", "private"],
      registers,
    }),
    timeToConnectSeconds: new Histogram({
      name: "chizzy_time_to_connect_seconds",
      help: "Time from call:start to a connected peer connection, from call:telemetry",
      buckets: [0.25, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 30],
      registers,
    }),
    callFailedTotal: new Counter({
      name: "chizzy_call_failed_total",
      help: "Calls ended by call:failed (connection could not be established)",
      labelNames: ["reason"],
      registers,
    }),
    moderationSignalsTotal: new Counter({
      name: "chizzy_moderation_signals_total",
      help: "On-device moderation signals, by kind",
      labelNames: ["kind"],
      registers,
    }),
    safetyNudgesTotal: new Counter({
      name: "chizzy_safety_nudges_total",
      help: "safety:nudge events sent, by kind (counted once per nudge, not per recipient)",
      labelNames: ["kind"],
      registers,
    }),
    chatRedactedTotal: new Counter({
      name: "chizzy_chat_redacted_total",
      help: "Chat messages with links, handles or phone numbers hidden by the guard",
      registers,
    }),
    namesReplacedTotal: new Counter({
      name: "chizzy_names_replaced_total",
      help: "Display names replaced with a generated nickname by the name guard",
      registers,
    }),
    earlySkipsTotal: new Counter({
      name: "chizzy_early_skips_total",
      help: "Partners skipped within the early-skip window of call start",
      registers,
    }),
    lowPriorityTotal: new Counter({
      name: "chizzy_low_priority_total",
      help: "Devices given low matching priority, by cause (never a ban)",
      labelNames: ["cause"],
      registers,
    }),
    acceptCooldownsTotal: new Counter({
      name: "chizzy_accept_cooldowns_total",
      help: "Devices kept out of the queue for letting too many accept windows expire",
      registers,
    }),
    turnCredentialsTotal: new Counter({
      name: "chizzy_turn_credentials_total",
      help: "Per-call TURN credential requests, by result",
      labelNames: ["result"],
      registers,
    }),
    turnSpendStepsTotal: new Counter({
      name: "chizzy_turn_spend_steps_total",
      help: "TURN spend poller step-downs applied, by step",
      labelNames: ["step"],
      registers,
    }),
    turnSpendPollErrorsTotal: new Counter({
      name: "chizzy_turn_spend_poll_errors_total",
      help: "TURN spend poller failures (analytics API unreachable or malformed)",
      registers,
    }),
    turnSpendFailsafeTotal: new Counter({
      name: "chizzy_turn_spend_failsafe_total",
      help: "Analytics outages long enough that the TURN spend poller applied its failsafe step-downs",
      registers,
    }),
    turnEgressGbToday: new Gauge({
      name: "chizzy_turn_egress_gb_today",
      help: "Cloudflare TURN egress so far today (UTC), in GB, as last polled",
      registers,
    }),
  };
}
