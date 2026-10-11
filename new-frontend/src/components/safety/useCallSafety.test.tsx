import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { initialSignalingState, type SignalingState } from "@/hooks/useSignaling";
import type { ReportAck } from "@/lib/protocol";
import { POST_CALL_REPORT_MS, useCallSafety, type SafetySignaling } from "./useCallSafety";
import { NudgeToast } from "./NudgeToast";
import { PostCallReport } from "./PostCallReport";

const ROOM = "22222222-2222-4222-8222-222222222222";
const FRAME = "data:image/jpeg;base64,BBBB";

vi.mock("@/lib/evidence", async (orig) => {
  const real = await orig<typeof import("@/lib/evidence")>();
  return { ...real, captureEvidenceFrame: vi.fn(() => FRAME) };
});

type Handler = (...args: unknown[]) => void;

function fakeSignaling(state: SignalingState) {
  const handlers = new Map<string, Set<Handler>>();
  const report = vi.fn(async (): Promise<ReportAck> => ({ ok: true, reportId: "r-1" }));
  const signaling: SafetySignaling = {
    state,
    report,
    subscribe: ((event: string, handler: Handler) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    }) as SafetySignaling["subscribe"],
  };
  const fire = (event: string, payload: unknown) =>
    act(() => {
      handlers.get(event)?.forEach((h) => h(payload));
    });
  return { signaling, fire, report };
}

const inCall: SignalingState = {
  ...initialSignalingState,
  status: "in-call",
  roomId: ROOM,
  partner: { name: "Zed", country: "IN", language: "en", topics: ["music"] },
  messages: [
    { id: "1", from: "partner", text: "hello", ts: 5 },
    { id: "2", from: "system", text: "friends", ts: 6 },
  ],
};

const video = () => document.createElement("video");

afterEach(() => {
  vi.useRealTimers();
});

describe("useCallSafety", () => {
  it("opens an in-call report with the partner frame and chat, pinned to the room", () => {
    const { signaling } = fakeSignaling(inCall);
    const { result } = renderHook(() => useCallSafety(signaling, video));
    act(() => result.current.openReport("call"));
    expect(result.current.target).toEqual({
      roomId: ROOM,
      context: "call",
      partnerName: "Zed",
      frame: FRAME,
      chat: [{ from: "partner", text: "hello", ts: 5 }],
    });
  });

  it("captures nothing for a match card report", () => {
    const { signaling } = fakeSignaling({ ...inCall, status: "match-found", messages: [] });
    const { result } = renderHook(() => useCallSafety(signaling, video));
    act(() => result.current.openReport("match"));
    expect(result.current.target).toMatchObject({ context: "match", frame: null, chat: [] });
  });

  it("offers a post-call report for 60 s after an in-call room ends, with evidence from that moment", async () => {
    vi.useFakeTimers();
    const { signaling, fire, report } = fakeSignaling(inCall);
    const { result } = renderHook(() => useCallSafety(signaling, video));

    fire("match:ended", { roomId: ROOM, reason: "partner-skipped" });
    expect(result.current.postCall).toMatchObject({ roomId: ROOM, partnerName: "Zed", frame: FRAME });

    act(() => result.current.openPostCallReport());
    expect(result.current.target).toMatchObject({ roomId: ROOM, context: "post-call", frame: FRAME });

    await act(async () => {
      await result.current.submitReport(ROOM, "harassment", undefined, { frame: FRAME });
    });
    expect(report).toHaveBeenCalledWith("harassment", undefined, { frame: FRAME }, ROOM);
    expect(result.current.postCall).toBeNull();
  });

  it("drops the post-call offer after the report window", () => {
    vi.useFakeTimers();
    const { signaling, fire } = fakeSignaling(inCall);
    const { result } = renderHook(() => useCallSafety(signaling, video));
    fire("match:ended", { roomId: ROOM, reason: "skipped" });
    expect(result.current.postCall).not.toBeNull();
    act(() => vi.advanceTimersByTime(POST_CALL_REPORT_MS + 10));
    expect(result.current.postCall).toBeNull();
  });

  it("does not offer a post-call report after reporting, or for a room that never connected", () => {
    const { signaling, fire } = fakeSignaling(inCall);
    const { result } = renderHook(() => useCallSafety(signaling, video));
    fire("match:ended", { roomId: ROOM, reason: "reported" });
    expect(result.current.postCall).toBeNull();

    const pending = fakeSignaling({ ...inCall, status: "match-found" });
    const r2 = renderHook(() => useCallSafety(pending.signaling, video));
    pending.fire("match:ended", { roomId: ROOM, reason: "timeout" });
    expect(r2.result.current.postCall).toBeNull();
  });

  it("shows nudges and remembers redacted chat lines", () => {
    const { signaling, fire } = fakeSignaling(inCall);
    const { result } = renderHook(() => useCallSafety(signaling, video));
    fire("safety:nudge", { roomId: ROOM, kind: "contact-sharing" });
    expect(result.current.nudge).toMatchObject({ roomId: ROOM, kind: "contact-sharing" });
    expect(result.current.chatNudge).toBe("contact-sharing");

    fire("chat:message", { roomId: ROOM, id: "m9", text: "x [hidden for safety]", ts: 1, redacted: true });
    fire("chat:message", { roomId: ROOM, id: "m10", text: "fine", ts: 2, redacted: false });
    act(() => result.current.noteChatAck({ ok: true, id: "m11", ts: 3, redacted: true }));
    expect([...result.current.redactedIds].sort()).toEqual(["m11", "m9"]);
  });
});

describe("NudgeToast", () => {
  it("explains the nudge, offers Report and dismisses itself", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const onReport = vi.fn();
    render(<NudgeToast nudge={{ id: 1, roomId: ROOM, kind: "solicitation" }} onDismiss={onDismiss} onReport={onReport} />);
    const toast = screen.getByTestId("nudge-toast");
    expect(toast).toHaveAttribute("role", "status");
    expect(toast).toHaveTextContent("If someone threatens you, do not pay; report it.");
    screen.getByRole("button", { name: "Report" }).click();
    expect(onReport).toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(15_000));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("has no Report button for a hidden link", () => {
    render(<NudgeToast nudge={{ id: 2, roomId: ROOM, kind: "link-hidden" }} onDismiss={vi.fn()} onReport={vi.fn()} />);
    expect(screen.getByTestId("nudge-toast")).toHaveTextContent("Link hidden for safety");
    expect(screen.queryByRole("button", { name: "Report" })).not.toBeInTheDocument();
  });
});

describe("PostCallReport", () => {
  it("counts down the 60 s window and opens the report", async () => {
    const onReport = vi.fn();
    render(
      <PostCallReport
        postCall={{ roomId: ROOM, partnerName: "Zed", endedAt: Date.now() - 15_000, frame: null, chat: [] }}
        onReport={onReport}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId("post-call-seconds")).toHaveTextContent("45");
    await userEvent.setup().click(screen.getByRole("button", { name: "Report this person" }));
    expect(onReport).toHaveBeenCalled();
  });
});
