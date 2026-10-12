/**
 * Decides whether a device may join the matching queue: the kill switch and
 * staffed hours, the max_waiting cap, the hourly match caps and the
 * per-minute skip cap. MatchService calls it on hello (admit) and on the
 * automatic re-queue after a call (requeue), reports every new match
 * (recordMatch) and every room a device ended itself (recordSkip).
 */
import { describeStaffedHours, type FlagsReader } from "../flags/flags";
import type { Logger } from "../logger";
import type { MatchEndReason } from "../protocol";
import type { MatchStore } from "../store/MatchStore";
import { CAP_MESSAGE, CLOSED_MESSAGE, FULL_MESSAGE, MINUTE_CAP_MESSAGE } from "./constants";
import type { MatchCaps } from "./limits";

/**
 * Re-queues the device did not cause: the partner ended the room. The
 * per-minute cap is not checked for them, so a waiter skipped by twenty
 * fast partners is not idled with "You are skipping very fast".
 */
const PASSIVE_REQUEUE: Partial<Record<MatchEndReason, true>> = { "partner-skipped": true, "partner-left": true, "partner-declined": true };

export interface QueueRefusal {
  error: "matching_closed" | "rate_limited";
  message: string;
}

export interface QueueGate {
  /**
   * The checks that need no per-device lookup: closed, or the queue at
   * max_waiting (one O(1) store read). MatchService runs it before any store
   * write or the match lock, so a crowd hitting a full queue costs no writes.
   */
  precheck(): Promise<QueueRefusal | null>;
  /** A new hello: closed, full or over a cap refuses it. */
  admit(deviceId: string): Promise<QueueRefusal | null>;
  /**
   * The automatic re-queue after a room ended for `reason`: the hourly caps
   * refuse it; the per-minute skip cap too unless the partner ended the room.
   */
  requeue(deviceId: string, reason: MatchEndReason): Promise<QueueRefusal | null>;
  /** Counts one match for this device (and its IP) against the hourly caps. Never throws. */
  recordMatch(deviceId: string): Promise<void>;
  /** Counts one room this device ended (call:skip, match:decline) against the per-minute cap. Never throws. */
  recordSkip(deviceId: string): Promise<void>;
}

export class SessionQueueGate implements QueueGate {
  constructor(
    private readonly flags: FlagsReader,
    private readonly store: Pick<MatchStore, "waitingCount">,
    private readonly caps: MatchCaps,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async precheck(): Promise<QueueRefusal | null> {
    const status = this.flags.status(this.now());
    if (!status.open) {
      const hours = describeStaffedHours(this.flags.current().staffed_hours);
      const message =
        status.message ?? (hours ? `Matching is open ${hours}. See you then.` : CLOSED_MESSAGE);
      return { error: "matching_closed", message };
    }
    if ((await this.store.waitingCount()) >= this.flags.current().max_waiting) {
      return { error: "matching_closed", message: FULL_MESSAGE };
    }
    return null;
  }

  async admit(deviceId: string): Promise<QueueRefusal | null> {
    return (await this.precheck()) ?? this.check(deviceId, true);
  }

  async requeue(deviceId: string, reason: MatchEndReason): Promise<QueueRefusal | null> {
    return this.check(deviceId, !PASSIVE_REQUEUE[reason]);
  }

  private async check(deviceId: string, skips: boolean): Promise<QueueRefusal | null> {
    try {
      const hit = await this.caps.overCap(deviceId, skips);
      if (hit) return { error: "rate_limited", message: hit === "minute" ? MINUTE_CAP_MESSAGE : CAP_MESSAGE };
    } catch (err) {
      this.logger.warn({ err }, "match cap check failed; allowing");
    }
    return null;
  }

  async recordMatch(deviceId: string): Promise<void> {
    try {
      await this.caps.recordMatch(deviceId);
    } catch (err) {
      this.logger.warn({ err }, "could not record a match for the hourly cap");
    }
  }

  async recordSkip(deviceId: string): Promise<void> {
    try {
      await this.caps.recordSkip(deviceId);
    } catch (err) {
      this.logger.warn({ err }, "could not record a skip for the per-minute cap");
    }
  }
}
