/**
 * Spark state: the prompt card both sides see and the shared cooldown.
 *
 * The server owns the cooldown (one prompt per room per SPARK.cooldownMs);
 * the client mirrors it from the moment spark:show arrives so the button can
 * draw a ring instead of asking and getting rate_limited.
 */
import { SPARK, type ErrorCode, type ServerToClientEvents } from "@/lib/protocol";

export type SparkShow = Parameters<ServerToClientEvents["spark:show"]>[0];

export interface SparkCard {
  roomId: string;
  promptId: string;
  from: SparkShow["from"];
  /** Local clock when the card appeared; it hides SPARK.cardMs later. */
  shownAt: number;
}

export interface SparkState {
  card: SparkCard | null;
  /** Local clock until which the button is on cooldown (0 = ready). */
  cooldownUntil: number;
  /** A request is in flight. */
  pending: boolean;
}

export type SparkAction =
  | { type: "request"; now: number }
  | { type: "show"; show: SparkShow; now: number }
  | { type: "ack"; ok: boolean; error?: ErrorCode; now: number }
  | { type: "expire"; now: number }
  | { type: "dismiss" }
  | { type: "reset" };

export const initialSparkState: SparkState = { card: null, cooldownUntil: 0, pending: false };

export function canRequest(state: SparkState, now: number): boolean {
  return !state.pending && now >= state.cooldownUntil;
}

export function sparkReducer(state: SparkState, action: SparkAction): SparkState {
  switch (action.type) {
    case "request":
      return canRequest(state, action.now) ? { ...state, pending: true } : state;
    case "show":
      return {
        card: { roomId: action.show.roomId, promptId: action.show.promptId, from: action.show.from, shownAt: action.now },
        cooldownUntil: action.now + SPARK.cooldownMs,
        pending: false,
      };
    case "ack": {
      if (action.ok) return state.pending ? { ...state, pending: false } : state;
      // rate_limited without a show means our clock ran ahead of the server's: start a full cooldown.
      const cooldownUntil =
        action.error === "rate_limited" && action.now >= state.cooldownUntil
          ? action.now + SPARK.cooldownMs
          : state.cooldownUntil;
      return { ...state, pending: false, cooldownUntil };
    }
    case "expire":
      return state.card && action.now - state.card.shownAt >= SPARK.cardMs ? { ...state, card: null } : state;
    case "dismiss":
      return state.card ? { ...state, card: null } : state;
    case "reset":
      return initialSparkState;
  }
}
