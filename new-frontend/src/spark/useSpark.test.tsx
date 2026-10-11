import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Signaling } from "@/hooks/useSignaling";
import { SPARK, type ServerToClientEvents, type SparkAck } from "@/lib/protocol";
import { resetPromptCache } from "./prompts";
import { SparkButton } from "./SparkButton";
import { SparkCard } from "./SparkCard";
import { useSpark } from "./useSpark";

type Handler = (...args: unknown[]) => void;
type Show = Parameters<ServerToClientEvents["spark:show"]>[0];

const ROOM = "11111111-1111-4111-8111-111111111111";

/** A signaling stub: records requests, lets the test fire server events. */
function fakeSignaling(reply: (roomId: string) => SparkAck = () => ({ ok: true, promptId: "food-04" })) {
  const listeners = new Map<string, Set<Handler>>();
  const requests: string[] = [];
  const subscribe = (event: string, handler: Handler) => {
    const set = listeners.get(event) ?? new Set<Handler>();
    set.add(handler);
    listeners.set(event, set);
    return () => {
      set.delete(handler);
    };
  };
  const request = vi.fn(async (_event: "spark:request", payload: { roomId: string }) => {
    requests.push(payload.roomId);
    return reply(payload.roomId);
  });
  return {
    requests,
    subscribe: subscribe as Signaling["subscribe"],
    request: request as unknown as Signaling["request"],
    fire(show: Show) {
      act(() => listeners.get("spark:show")?.forEach((h) => h(show)));
    },
  };
}

const Harness: React.FC<{ signaling: ReturnType<typeof fakeSignaling>; roomId: string | null }> = ({ signaling, roomId }) => {
  const spark = useSpark({ signaling, roomId });
  return (
    <>
      <SparkButton spark={spark} />
      <SparkCard spark={spark} />
    </>
  );
};

const flush = () => act(() => Promise.resolve());

beforeEach(() => {
  resetPromptCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        version: 1,
        prompts: [
          { id: "food-04", topics: ["food"], text: url.includes(".hi.") ? "पिज़्ज़ा पर पाइनएप्पल: हाँ या ना?" : "Pineapple on pizza: yes or no?" },
        ],
      }),
    })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useSpark", () => {
  it("the button asks the server for the current room and the card shows the prompt text both sides share", async () => {
    const signaling = fakeSignaling();
    render(<Harness signaling={signaling} roomId={ROOM} />);
    await flush();
    const button = screen.getByTestId("spark-button");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(signaling.requests).toEqual([ROOM]);
    expect(screen.queryByTestId("spark-card")).toBeNull();

    signaling.fire({ roomId: ROOM, promptId: "food-04", from: "you", at: Date.now() });
    await flush();
    const card = screen.getByTestId("spark-card");
    expect(card).toHaveAttribute("data-prompt-id", "food-04");
    expect(card).toHaveAttribute("data-from", "you");
    expect(screen.getByTestId("spark-text")).toHaveTextContent("Pineapple on pizza: yes or no?");
    // The shared cooldown runs: the button and "Another" wait.
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-cooldown", "1");
    expect(screen.getByTestId("spark-another")).toBeDisabled();
  });

  it("a partner's spark shows the same card tagged as theirs and dismiss hides it", async () => {
    const signaling = fakeSignaling();
    render(<Harness signaling={signaling} roomId={ROOM} />);
    signaling.fire({ roomId: ROOM, promptId: "food-04", from: "partner", at: Date.now() });
    await flush();
    expect(screen.getByTestId("spark-card")).toHaveAttribute("data-from", "partner");
    fireEvent.click(screen.getByTestId("spark-dismiss"));
    expect(screen.queryByTestId("spark-card")).toBeNull();
  });

  it("ignores a spark for another room and does nothing outside a call", async () => {
    const signaling = fakeSignaling();
    render(<Harness signaling={signaling} roomId={null} />);
    const button = screen.getByTestId("spark-button");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(signaling.requests).toEqual([]);
    signaling.fire({ roomId: "22222222-2222-4222-8222-222222222222", promptId: "food-04", from: "partner", at: Date.now() });
    await flush();
    expect(screen.queryByTestId("spark-card")).toBeNull();
  });

  it("the card hides itself after SPARK.cardMs and the button is ready again after the cooldown", async () => {
    vi.useFakeTimers();
    const signaling = fakeSignaling();
    render(<Harness signaling={signaling} roomId={ROOM} />);
    signaling.fire({ roomId: ROOM, promptId: "food-04", from: "you", at: Date.now() });
    expect(screen.getByTestId("spark-card")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(SPARK.cooldownMs + 200);
    });
    expect(screen.getByTestId("spark-button")).toBeEnabled();
    act(() => {
      vi.advanceTimersByTime(SPARK.cardMs - SPARK.cooldownMs);
    });
    expect(screen.queryByTestId("spark-card")).toBeNull();
  });

  it("a rate_limited ack puts the button on cooldown without a card", async () => {
    const signaling = fakeSignaling(() => ({ ok: false, error: "rate_limited" }));
    render(<Harness signaling={signaling} roomId={ROOM} />);
    fireEvent.click(screen.getByTestId("spark-button"));
    await flush();
    expect(screen.getByTestId("spark-button")).toHaveAttribute("data-cooldown", "1");
    expect(screen.queryByTestId("spark-card")).toBeNull();
  });
});
