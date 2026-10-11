/**
 * Live captions relay. The sender's browser transcribes its own speech and
 * sends caption:segment; the server forwards it, unchanged, to the other
 * ACTIVE member of the room. Nothing is stored and the text is never logged.
 *
 * Over CAPTIONS.maxPerSec per socket the segment is dropped (no ack, no
 * server:error: interim results are disposable and the next one replaces
 * them). Size is capped by captionSegmentSchema before this runs.
 */
import type { Emitter } from "../match/MatchService";
import type { Metrics } from "../metrics";
import { CAPTIONS, type CaptionSegmentPayload } from "../protocol";
import { TokenBucket } from "../rateLimit";
import { activeMember } from "../realtime/roomMembership";
import type { MatchStore } from "../store/MatchStore";

export interface CaptionRelayDeps {
  store: MatchStore;
  emitter: Emitter;
  metrics: Pick<Metrics, "rateLimitedTotal">;
  /** Injectable clock for tests. */
  now?: () => number;
}

export const CAPTION_EVENT = "caption:segment";

export class CaptionRelay {
  private readonly store: MatchStore;
  private readonly emitter: Emitter;
  private readonly metrics: Pick<Metrics, "rateLimitedTotal">;
  private readonly now: () => number;
  /** Per-socket budget; entries leave in forget() when the socket disconnects. */
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(deps: CaptionRelayDeps) {
    this.store = deps.store;
    this.emitter = deps.emitter;
    this.metrics = deps.metrics;
    this.now = deps.now ?? Date.now;
  }

  async segment(socketId: string, payload: CaptionSegmentPayload): Promise<void> {
    const now = this.now();
    let bucket = this.buckets.get(socketId);
    if (!bucket) {
      bucket = new TokenBucket({ capacity: CAPTIONS.maxPerSec, refillPerSec: CAPTIONS.maxPerSec }, now);
      this.buckets.set(socketId, bucket);
    }
    if (!bucket.take(now)) {
      this.metrics.rateLimitedTotal.inc({ event: CAPTION_EVENT });
      return;
    }
    const member = await activeMember(this.store, socketId, payload.roomId);
    if (member) this.emitter.emit(member.partner, CAPTION_EVENT, payload);
  }

  forget(socketId: string): void {
    this.buckets.delete(socketId);
  }
}
