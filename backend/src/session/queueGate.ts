/**
 * Decides whether a device may join the matching queue: the kill switch and
 * staffed hours, the max_waiting cap and the hourly match caps. MatchService
 * calls it on hello (admit) and on the automatic re-queue after a call
 * (requeue), and reports every new match (recordMatch).
 */
import { describeStaffedHours, type FlagsReader } from "../flags/flags";
import type { Logger } from "../logger";
import type { MatchStore } from "../store/MatchStore";
import type { MatchCaps } from "./limits";

export interface QueueRefusal {
  error: "matching_closed" | "rate_limited";
  message: string;
}

export interface QueueGate {
  /** A new hello: closed, full or over the hourly cap refuses it. */
  admit(deviceId: string): Promise<QueueRefusal | null>;
  /** The automatic re-queue after a call: only the hourly cap refuses it. */
  requeue(deviceId: string): Promise<QueueRefusal | null>;
  /** Counts one match for this device (and its IP). Never throws. */
  recordMatch(deviceId: string): Promise<void>;
}

export const CAP_MESSAGE = "You have had a lot of matches this hour. Take a break and try again later.";
export const FULL_MESSAGE = "A lot of people are waiting right now. Try again in a few minutes.";

export class SessionQueueGate implements QueueGate {
  constructor(
    private readonly flags: FlagsReader,
    private readonly store: Pick<MatchStore, "stats">,
    private readonly caps: MatchCaps,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async admit(deviceId: string): Promise<QueueRefusal | null> {
    const status = this.flags.status(this.now());
    if (!status.open) {
      const hours = describeStaffedHours(this.flags.current().staffed_hours);
      const message =
        status.message ?? (hours ? `Matching is open ${hours}. See you then.` : "Matching is closed right now.");
      return { error: "matching_closed", message };
    }
    const { waiting } = await this.store.stats();
    if (waiting >= this.flags.current().max_waiting) return { error: "matching_closed", message: FULL_MESSAGE };
    return this.requeue(deviceId);
  }

  async requeue(deviceId: string): Promise<QueueRefusal | null> {
    try {
      if (await this.caps.overCap(deviceId)) return { error: "rate_limited", message: CAP_MESSAGE };
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
}
