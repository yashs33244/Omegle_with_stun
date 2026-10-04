import { useCallback, useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { initialSignalingState, type Signaling, type SignalingState } from "@/hooks/useSignaling";
import { resetObservabilityForTests, setCaptureForTests } from "@/lib/observability";
import type { PublicConfig, Restriction, ServerToClientEvents } from "@/lib/protocol";
import { GateContext, type GateContextValue } from "./GateContext";
import { useRoomGate } from "./useRoomGate";

type Listener = (...args: unknown[]) => void;

const config: PublicConfig = {
  tosVersion: "v",
  turnstileSiteKey: null,
  sentryDsn: null,
  posthogKey: null,
  posthogHost: null,
  banner: null,
  matchingOpen: true,
  staffedHours: "8 pm to midnight IST",
  reopensAt: null,
  defaultMode: "instant",
  privateModeEnabled: true,
};

function setup(status: SignalingState["status"] = "waiting") {
  const listeners = new Map<string, Set<Listener>>();
  const signaling = {
    state: { ...initialSignalingState, status },
    subscribe: vi.fn((event: string, handler: Listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    }) as unknown as Signaling["subscribe"],
    retry: vi.fn(),
  };
  const gate: GateContextValue = {
    config,
    setBanner: vi.fn(),
    showRestriction: vi.fn(),
    refreshConfig: vi.fn(async () => config),
  };
  const onLeave = vi.fn();
  const Harness = ({ state, connected = false }: { state: SignalingState; connected?: boolean }) => {
    const { overlay } = useRoomGate({ ...signaling, state }, { onLeave, connected });
    return <div data-testid="room">{overlay}</div>;
  };
  const view = render(
    <GateContext.Provider value={gate}>
      <Harness state={signaling.state} />
    </GateContext.Provider>,
  );
  const rerender = (state: Partial<SignalingState>, connected = false) =>
    view.rerender(
      <GateContext.Provider value={gate}>
        <Harness state={{ ...signaling.state, ...state }} connected={connected} />
      </GateContext.Provider>,
    );
  const fire = <E extends keyof ServerToClientEvents>(event: E, ...args: Parameters<ServerToClientEvents[E]>) =>
    act(() => listeners.get(event)?.forEach((h) => h(...args)));
  return { signaling, gate, onLeave, rerender, fire };
}

beforeEach(() => resetObservabilityForTests());

describe("useRoomGate", () => {
  it("passes live banners and restrictions to the gate", () => {
    const { gate, fire } = setup();
    fire("server:banner", { message: "Back in 5 minutes" });
    expect(gate.setBanner).toHaveBeenCalledWith("Back in 5 minutes");

    const restriction = { id: "r1", reason: "spam", kind: "pause" } as Restriction;
    fire("session:restricted", { restriction });
    expect(gate.showRestriction).toHaveBeenCalledWith(restriction);
  });

  it("shows the closed overlay while waiting and says hello again when matching reopens", () => {
    const { signaling, rerender, fire } = setup("waiting");
    fire("matching:status", { open: false, reopensAt: Date.now() + 60_000, message: "Closed for the night" });
    expect(screen.getByRole("dialog", { name: "Chizzy is closed" })).toHaveTextContent("Chizzy is open 8 pm to midnight IST");
    expect(screen.getByText("Closed for the night")).toBeInTheDocument();

    rerender({ status: "error" });
    fire("matching:status", { open: true, reopensAt: null, message: null });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(signaling.retry).toHaveBeenCalledTimes(1);
  });

  it("does not cover a call in progress", () => {
    const { fire } = setup("in-call");
    fire("matching:status", { open: false, reopensAt: null, message: null });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains a refused hello when the config says matching is closed", async () => {
    const { gate, rerender } = setup("waiting");
    vi.mocked(gate.refreshConfig).mockResolvedValue({ ...config, matchingOpen: false, reopensAt: Date.now() + 5000 });
    rerender({ status: "error" });
    expect(await screen.findByRole("dialog", { name: "Chizzy is closed" })).toBeInTheDocument();
  });

  it("records the match funnel", () => {
    const events: string[] = [];
    setCaptureForTests((e) => events.push(e));
    const { rerender } = setup("waiting");
    rerender({ status: "match-found" });
    rerender({ status: "in-call" });
    rerender({ status: "in-call" }, true);
    rerender({ status: "waiting" });
    rerender({ status: "match-found" });
    expect(events).toEqual(["first_match", "match_accepted", "call_connected"]);
  });

  it("re-reads the config once per refused hello, even though that changes the gate context", async () => {
    const refreshes = vi.fn();
    const Provider = ({ children }: { children: React.ReactNode }) => {
      const [cfg, setCfg] = useState(config);
      const refreshConfig = useCallback(async () => {
        refreshes();
        const next = { ...config };
        setCfg(next);
        return next;
      }, []);
      const setBanner = useCallback(() => {}, []);
      const showRestriction = useCallback(() => {}, []);
      const value = useMemo(
        () => ({ config: cfg, setBanner, showRestriction, refreshConfig }),
        [cfg, setBanner, showRestriction, refreshConfig],
      );
      return <GateContext.Provider value={value}>{children}</GateContext.Provider>;
    };
    const Harness = () => {
      useRoomGate(
        { state: { ...initialSignalingState, status: "error" }, subscribe: () => () => {}, retry: () => {} },
        { onLeave: () => {}, connected: false },
      );
      return null;
    };
    render(
      <Provider>
        <Harness />
      </Provider>,
    );
    await waitFor(() => expect(refreshes).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(refreshes).toHaveBeenCalledTimes(1);
  });
});
