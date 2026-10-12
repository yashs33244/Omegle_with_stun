/**
 * Live captions relay. The sender's browser transcribes its own speech and
 * sends caption:segment; the server forwards it to the other ACTIVE member of
 * the room. Nothing is stored and the text is never logged.
 *
 * Captions are a text channel to a stranger, so they get the same treatment as
 * chat: the chat guard hides links, handles and phone numbers during the first
 * chatGuardMs of the call (a modified client can send anything here), and each
 * socket has a byte budget (CAPTIONS.maxBytesPerSec) on top of the segment
 * count cap (CAPTIONS.maxPerSec). Over either budget the segment is dropped
 * (no ack, no server:error): interim results are disposable and the next one
 * replaces them. Size is capped by captionSegmentSchema before this runs.
 */
import type { Emitter } from "../match/MatchService";
import type { Metrics } from "../metrics";
import { CAPTIONS, type CaptionSegmentPayload } from "../protocol";
import { TokenBucket } from "../rateLimit";
import { activeMember } from "../realtime/roomMembership";
import { guardChat } from "../safety/guard";
import type { MatchStore } from "../store/MatchStore";

export interface CaptionRelayDeps {
  store: MatchStore;
  emitter: Emitter;
  metrics: Pick<Metrics, "rateLimitedTotal" | "captionsRedactedTotal">;
  /** Contact details are hidden for this long (ms) after the call became active; same value as chat. */
  chatGuardMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export const CAPTION_EVENT = "caption:segment";

interface SocketBudget {
  segments: TokenBucket;
  bytes: TokenBucket;
}

export class CaptionRelay {
  private readonly store: MatchStore;
  private readonly emitter: Emitter;
  private readonly metrics: CaptionRelayDeps["metrics"];
  private readonly chatGuardMs: number;
  private readonly now: () => number;
  /** Per-socket budgets; entries leave in forget() when the socket disconnects. */
  private readonly budgets = new Map<string, SocketBudget>();

  constructor(deps: CaptionRelayDeps) {
    this.store = deps.store;
    this.emitter = deps.emitter;
    this.metrics = deps.metrics;
    this.chatGuardMs = deps.chatGuardMs;
    this.now = deps.now ?? Date.now;
  }

  async segment(socketId: string, payload: CaptionSegmentPayload): Promise<void> {
    const now = this.now();
    let budget = this.budgets.get(socketId);
    if (!budget) {
      budget = {
        segments: new TokenBucket({ capacity: CAPTIONS.maxPerSec, refillPerSec: CAPTIONS.maxPerSec }, now),
        bytes: new TokenBucket({ capacity: 2 * CAPTIONS.maxBytesPerSec, refillPerSec: CAPTIONS.maxBytesPerSec }, now),
      };
      this.budgets.set(socketId, budget);
    }
    if (!budget.segments.take(now) || !budget.bytes.take(now, Buffer.byteLength(payload.text))) {
      this.metrics.rateLimitedTotal.inc({ event: CAPTION_EVENT });
      return;
    }
    const member = await activeMember(this.store, socketId, payload.roomId);
    if (!member) return;
    const guarded = guardChat(payload.text, { redact: now - (member.room.activeSince ?? now) < this.chatGuardMs });
    if (guarded.redacted) this.metrics.captionsRedactedTotal.inc();
    this.emitter.emit(member.partner, CAPTION_EVENT, { ...payload, text: guarded.text });
  }

  forget(socketId: string): void {
    this.budgets.delete(socketId);
  }
}
