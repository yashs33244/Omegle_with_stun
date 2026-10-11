import { describe, expect, it } from "vitest";
import { SPARK } from "@/lib/protocol";
import { canRequest, initialSparkState, sparkReducer, type SparkState } from "./sparkReducer";

const ROOM = "11111111-1111-4111-8111-111111111111";
const show = (promptId: string, from: "you" | "partner" = "you") => ({ roomId: ROOM, promptId, from, at: 5_000 });

describe("sparkReducer", () => {
  it("starts ready, with no card", () => {
    expect(initialSparkState.card).toBeNull();
    expect(canRequest(initialSparkState, 0)).toBe(true);
  });

  it("a request is pending until its ack; a second request is ignored meanwhile", () => {
    const pending = sparkReducer(initialSparkState, { type: "request", now: 1_000 });
    expect(pending.pending).toBe(true);
    expect(canRequest(pending, 1_000)).toBe(false);
    expect(sparkReducer(pending, { type: "request", now: 1_001 })).toBe(pending);
    const acked = sparkReducer(pending, { type: "ack", ok: true, now: 1_050 });
    expect(acked.pending).toBe(false);
  });

  it("spark:show sets the card and starts the shared cooldown from the local clock", () => {
    const state = sparkReducer(initialSparkState, { type: "show", show: show("food-01", "partner"), now: 10_000 });
    expect(state.card).toEqual({ roomId: ROOM, promptId: "food-01", from: "partner", shownAt: 10_000 });
    expect(state.pending).toBe(false);
    expect(state.cooldownUntil).toBe(10_000 + SPARK.cooldownMs);
    expect(canRequest(state, 10_000 + SPARK.cooldownMs - 1)).toBe(false);
    expect(canRequest(state, 10_000 + SPARK.cooldownMs)).toBe(true);
  });

  it("the card expires after SPARK.cardMs and not before", () => {
    const shown = sparkReducer(initialSparkState, { type: "show", show: show("art-02"), now: 0 });
    expect(sparkReducer(shown, { type: "expire", now: SPARK.cardMs - 1 }).card).not.toBeNull();
    expect(sparkReducer(shown, { type: "expire", now: SPARK.cardMs }).card).toBeNull();
  });

  it("a newer card is not expired by the previous card's timer", () => {
    const first = sparkReducer(initialSparkState, { type: "show", show: show("art-02"), now: 0 });
    const second = sparkReducer(first, { type: "show", show: show("art-03"), now: SPARK.cooldownMs });
    expect(sparkReducer(second, { type: "expire", now: SPARK.cardMs }).card?.promptId).toBe("art-03");
  });

  it("dismiss hides the card but keeps the cooldown", () => {
    const shown = sparkReducer(initialSparkState, { type: "show", show: show("art-02"), now: 0 });
    const dismissed = sparkReducer(shown, { type: "dismiss" });
    expect(dismissed.card).toBeNull();
    expect(dismissed.cooldownUntil).toBe(SPARK.cooldownMs);
  });

  it("rate_limited with no cooldown running starts one (server clock ahead); other errors just clear pending", () => {
    const pending = sparkReducer(initialSparkState, { type: "request", now: 1_000 });
    const limited = sparkReducer(pending, { type: "ack", ok: false, error: "rate_limited", now: 1_100 });
    expect(limited.pending).toBe(false);
    expect(limited.cooldownUntil).toBe(1_100 + SPARK.cooldownMs);

    const cooling: SparkState = { ...pending, cooldownUntil: 9_000 };
    expect(sparkReducer(cooling, { type: "ack", ok: false, error: "rate_limited", now: 1_100 }).cooldownUntil).toBe(9_000);
    const failed = sparkReducer(pending, { type: "ack", ok: false, error: "not_in_room", now: 1_100 });
    expect(failed).toEqual({ ...pending, pending: false });
  });

  it("reset returns to the initial state", () => {
    const shown = sparkReducer(initialSparkState, { type: "show", show: show("art-02"), now: 0 });
    expect(sparkReducer(shown, { type: "reset" })).toBe(initialSparkState);
  });
});
