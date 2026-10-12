import React, { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Preferences, Profile } from "@/lib/protocol";
import { initialSignalingState, type SignalingState } from "@/hooks/useSignaling";
import type { PeerConnectionState } from "@/hooks/usePeerConnection";
import { SAFETY_COACH_KEY } from "@/components/safety/safetyText";
import { CAPTIONS_KEY } from "@/captions";
import type * as MediaQuery from "@/hooks/useMediaQuery";
import { PremiumContext, type PremiumValue } from "@/premium/PremiumContext";

let signalingState: SignalingState;
let peerState: PeerConnectionState;
const skip = vi.fn();
const reportConnected = vi.fn();
/** Server events the room subscribed to (captions, spark), by event name. */
const subscribers = new Map<string, Set<(payload: unknown) => void>>();
function emitServerEvent(event: string, payload: unknown) {
  act(() => subscribers.get(event)?.forEach((handler) => handler(payload)));
}

vi.mock("@/hooks/useSignaling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useSignaling")>();
  return {
    ...actual,
    useSignaling: () => ({
      state: signalingState,
      accept: vi.fn(),
      decline: vi.fn(),
      skip,
      sendChat: vi.fn(),
      setTyping: vi.fn(),
      report: vi.fn(),
      updatePreferences: vi.fn(),
      sendSignal: vi.fn(),
      reportConnected,
      subscribeSignals: vi.fn(() => () => {}),
      retry: vi.fn(),
      search: vi.fn(),
      subscribe: vi.fn((event: string, handler: (payload: unknown) => void) => {
        const set = subscribers.get(event) ?? new Set();
        set.add(handler);
        subscribers.set(event, set);
        return () => set.delete(handler);
      }),
      send: vi.fn(),
      request: vi.fn(async () => ({ ok: false as const, error: "internal" as const })),
    }),
  };
});
vi.mock("@/hooks/usePeerConnection", () => ({ usePeerConnection: () => peerState }));
vi.mock("@/hooks/useAudioLevelDetection", () => ({ useAudioLevelDetection: () => ({ isSpeaking: false }) }));
// jsdom has no matchMedia: these tests render the desktop (two-column) layout.
let desktopLayout = true;
let landscapeLayout = false;
vi.mock("@/hooks/useMediaQuery", async (importOriginal) => {
  const actual = await importOriginal<typeof MediaQuery>();
  return {
    ...actual,
    useMediaQuery: (query: string) =>
      query === actual.DESKTOP_QUERY ? desktopLayout : query === actual.LANDSCAPE_QUERY ? landscapeLayout : false,
  };
});

const { Room } = await import("./Room");

/** The media lane's peer fields, for a call that is neither private nor degraded. */
const continueWithoutPrivate = vi.fn();
const PEER_EXTRAS = {
  failure: null,
  privateMode: false,
  privateRequested: false,
  privateBlocked: false,
  continueWithoutPrivate,
  relayed: false,
  lowBandwidth: false,
};
/** A premium context with nothing unlocked, for the gender filter notice. */
const PREMIUM_OFF: PremiumValue = {
  catalogue: null,
  wallet: null,
  sheetOpen: false,
  busy: null,
  pending: false,
  openUnlockSheet: vi.fn(),
  closeUnlockSheet: vi.fn(),
  refresh: vi.fn(async () => undefined),
  applyWallet: vi.fn(),
  applyCoins: vi.fn(),
  unlock: vi.fn(async () => ({ ok: true as const })),
  buy: vi.fn(async () => ({ ok: true as const })),
};

// These tests are about the call itself: the first-use safety card was already dismissed.
beforeEach(() => {
  localStorage.setItem(SAFETY_COACH_KEY, "1");
});
afterEach(() => {
  localStorage.clear();
});

const profile: Profile = { name: "Ana", country: "IN", language: "en", gender: "unspecified", topics: ["music"] };
const preferences: Preferences = { genderFilter: "all", languageFilter: "any" };
const ROOM = "11111111-1111-4111-8111-111111111111";

function inCall(overrides: Partial<SignalingState> = {}): SignalingState {
  return {
    ...initialSignalingState,
    status: "in-call",
    roomId: ROOM,
    initiator: true,
    coins: 100,
    partner: { name: "Bo", country: "IN", language: "en", topics: ["music"] },
    ...overrides,
  };
}

/** Holds the mic state like Landing does, and records every change. */
function Harness({ micChanges, cameraChanges }: { micChanges: boolean[]; cameraChanges: boolean[] }) {
  const [micEnabled, setMicEnabled] = useState(true);
  const onMicEnabledChange = useCallback(
    (enabled: boolean) => {
      micChanges.push(enabled);
      setMicEnabled(enabled);
    },
    [micChanges],
  );
  const onCameraEnabledChange = useCallback((enabled: boolean) => cameraChanges.push(enabled), [cameraChanges]);
  return (
    <Room
      profile={profile}
      preferences={preferences}
      localStream={null}
      micEnabled={micEnabled}
      onMicEnabledChange={onMicEnabledChange}
      onCameraEnabledChange={onCameraEnabledChange}
      onBackToHome={vi.fn()}
    />
  );
}

function renderRoom() {
  const micChanges: boolean[] = [];
  const cameraChanges: boolean[] = [];
  const utils = render(<Harness micChanges={micChanges} cameraChanges={cameraChanges} />);
  return { ...utils, micChanges, cameraChanges };
}

const micToggle = () => screen.getByTestId("mic-toggle");

describe("Room text-only mode", () => {
  beforeEach(() => {
    signalingState = inCall();
    peerState = {
      remoteStream: null,
      remoteAudioTrack: null,
      connectionState: "connected",
      connectedAt: Date.now(),
      quality: "GOOD",
      ...PEER_EXTRAS,
    };
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("turns camera and mic off and keeps a visible mic toggle", () => {
    const { micChanges, cameraChanges } = renderRoom();
    fireEvent.click(screen.getByRole("button", { name: /Text Only/ }));
    expect(cameraChanges.at(-1)).toBe(false);
    expect(micChanges.at(-1)).toBe(false);
    expect(micToggle()).toHaveAccessibleName("Unmute microphone");
    expect(screen.getByText("Your camera and microphone are off.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Switch to Video/ }));
    expect(cameraChanges.at(-1)).toBe(true);
    expect(micChanges.at(-1)).toBe(true);
    expect(micToggle()).toHaveAccessibleName("Mute microphone");
  });

  it("lets you talk in text-only and keeps your mic choice when going back to video", () => {
    const { micChanges } = renderRoom();
    fireEvent.click(screen.getByRole("button", { name: /Text Only/ }));
    fireEvent.click(micToggle());
    expect(micToggle()).toHaveAccessibleName("Mute microphone");
    expect(screen.getByText("Your camera is off, but they can still hear you.")).toBeInTheDocument();
    fireEvent.click(micToggle());
    fireEvent.click(screen.getByRole("button", { name: /Switch to Video/ }));
    expect(micChanges).toEqual([false, true, false]);
    expect(micToggle()).toHaveAccessibleName("Unmute microphone");
  });

  it("leaves a mic that was already muted muted after text-only", () => {
    const { micChanges } = renderRoom();
    fireEvent.click(micToggle());
    fireEvent.click(screen.getByRole("button", { name: /Text Only/ }));
    fireEvent.click(screen.getByRole("button", { name: /Switch to Video/ }));
    expect(micChanges).toEqual([false]);
    expect(micToggle()).toHaveAccessibleName("Unmute microphone");
  });

  it("restores the mic when the next call starts in video", () => {
    const { micChanges, cameraChanges, rerender } = renderRoom();
    fireEvent.click(screen.getByRole("button", { name: /Text Only/ }));
    signalingState = inCall({ roomId: "22222222-2222-4222-8222-222222222222" });
    rerender(<Harness micChanges={micChanges} cameraChanges={cameraChanges} />);
    expect(micChanges.at(-1)).toBe(true);
    expect(screen.getByRole("button", { name: /Text Only/ })).toBeInTheDocument();
  });
});

describe("Room when the call connection fails", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    signalingState = inCall();
    peerState = {
      remoteStream: null,
      remoteAudioTrack: null,
      connectionState: "failed",
      connectedAt: null,
      quality: "DISCONNECTED",
      ...PEER_EXTRAS,
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows the error and skips by itself after 10 s on the initiator", () => {
    renderRoom();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't connect the video");
    act(() => vi.advanceTimersByTime(9_900));
    expect(skip).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it("waits longer on the answering side, so the initiator normally skips first", () => {
    signalingState = inCall({ initiator: false });
    renderRoom();
    act(() => vi.advanceTimersByTime(10_000));
    expect(skip).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(4_000));
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it("does not skip when the connection recovers (after the ICE restart)", () => {
    const { micChanges, cameraChanges, rerender } = renderRoom();
    act(() => vi.advanceTimersByTime(5_000));
    peerState = { ...peerState, connectionState: "connected", quality: "GOOD" };
    rerender(<Harness micChanges={micChanges} cameraChanges={cameraChanges} />);
    act(() => vi.advanceTimersByTime(20_000));
    expect(skip).not.toHaveBeenCalled();
  });

  it("does not skip a user who is chatting in text-only mode", () => {
    peerState = { ...peerState, connectionState: "connected", quality: "GOOD" };
    const { micChanges, cameraChanges, rerender } = renderRoom();
    fireEvent.click(screen.getByRole("button", { name: /Text Only/ }));
    peerState = { ...peerState, connectionState: "failed", quality: "DISCONNECTED" };
    rerender(<Harness micChanges={micChanges} cameraChanges={cameraChanges} />);
    act(() => vi.advanceTimersByTime(20_000));
    expect(skip).not.toHaveBeenCalled();
  });
});

describe("Room call timer and connection report", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    signalingState = inCall();
    peerState = {
      remoteStream: null,
      remoteAudioTrack: null,
      connectionState: "connecting",
      connectedAt: null,
      quality: "GOOD",
      ...PEER_EXTRAS,
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("starts the timer and tells the server only once the media connects", () => {
    const { micChanges, cameraChanges, rerender } = renderRoom();
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText("Connected: 0:00")).toBeInTheDocument();
    expect(reportConnected).not.toHaveBeenCalled();

    peerState = { ...peerState, connectionState: "connected", connectedAt: Date.now() };
    rerender(<Harness micChanges={micChanges} cameraChanges={cameraChanges} />);
    expect(reportConnected).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(65_000));
    expect(screen.getByText("Connected: 1:05")).toBeInTheDocument();
  });
});

describe("Room action bar and chat", () => {
  const message = (id: string, from: "me" | "partner", text: string) => ({ id, from, text, ts: 1 });

  beforeEach(() => {
    signalingState = inCall();
    peerState = {
      remoteStream: null,
      remoteAudioTrack: null,
      connectionState: "connected",
      connectedAt: Date.now(),
      quality: "GOOD",
      ...PEER_EXTRAS,
    };
  });
  afterEach(() => {
    desktopLayout = true;
    landscapeLayout = false;
    vi.clearAllMocks();
  });

  it("has Next, Stop, Chat, Report and the mic in one bar, and Next skips", () => {
    renderRoom();
    const bar = screen.getByTestId("call-actions");
    for (const id of ["next-button", "stop-button", "chat-toggle", "report-button", "mic-toggle", "text-only-toggle"]) {
      expect(bar.contains(screen.getByTestId(id)), id).toBe(true);
    }
    expect(screen.queryByTestId("flip-camera")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("next-button"));
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it("counts partner messages that arrive while the chat is closed and clears them on open", () => {
    const { micChanges, cameraChanges, rerender } = renderRoom();
    expect(screen.queryByTestId("chat-unread")).not.toBeInTheDocument();

    signalingState = inCall({ messages: [message("a", "partner", "hi"), message("b", "me", "yo"), message("c", "partner", "there?")] });
    rerender(<Harness micChanges={micChanges} cameraChanges={cameraChanges} />);
    expect(screen.getByTestId("chat-unread")).toHaveTextContent("2");
    expect(screen.getByTestId("chat-toast")).toHaveTextContent("there?");

    fireEvent.click(screen.getByTestId("chat-toggle"));
    expect(screen.getByTestId("chat-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("chat-input")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-unread")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-toast")).not.toBeInTheDocument();
  });

  it("opens the chat as a sheet over the video on phones", () => {
    desktopLayout = false;
    renderRoom();
    expect(screen.queryByTestId("chat-sheet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("chat-toggle"));
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.contains(screen.getByTestId("chat-input"))).toBe(true);
    fireEvent.click(screen.getByTestId("chat-close"));
    expect(screen.queryByTestId("chat-sheet")).not.toBeInTheDocument();
    // Text-only keeps the sheet up without a close button.
    fireEvent.click(screen.getByRole("button", { name: /Text Only/ }));
    expect(screen.getByTestId("chat-sheet")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-close")).not.toBeInTheDocument();
  });

  it("keeps the captions overlay above the bar on portrait phones and beside the rail in landscape", () => {
    localStorage.setItem(CAPTIONS_KEY, "1");
    desktopLayout = false;
    const { micChanges, cameraChanges, rerender } = renderRoom();
    const segment = { roomId: ROOM, id: "p1", text: "hello there", final: true, lang: "en" };
    emitServerEvent("caption:segment", segment);
    const overlay = screen.getByTestId("captions-overlay");
    expect(overlay).toHaveTextContent("hello there");
    expect(overlay.style.bottom).toMatch(/^calc\(\d+px \+ 0\.75rem\)$/);
    expect(overlay.style.right).toBe("");

    landscapeLayout = true;
    rerender(<Harness micChanges={micChanges} cameraChanges={cameraChanges} />);
    const rail = screen.getByTestId("captions-overlay");
    expect(rail.style.bottom).toContain("env(safe-area-inset-bottom)");
    expect(rail.style.bottom).toContain("0.75rem");
    expect(rail.style.right).toMatch(/^calc\(\d+px \+ 0\.5rem\)$/);
  });
});

describe("Room gender filter downgrade", () => {
  beforeEach(() => {
    peerState = { remoteStream: null, remoteAudioTrack: null, connectionState: "new", connectedAt: null, quality: "GOOD", ...PEER_EXTRAS };
  });

  it("adopts the server's filter, tells Landing, and offers the unlock sheet", () => {
    signalingState = { ...initialSignalingState, status: "waiting", coins: 100, genderFilter: "all" };
    const onPreferencesChange = vi.fn();
    const openUnlockSheet = vi.fn();
    render(
      <PremiumContext.Provider value={{ ...PREMIUM_OFF, openUnlockSheet }}>
        <Room
          profile={profile}
          preferences={{ genderFilter: "female", languageFilter: "any" }}
          onPreferencesChange={onPreferencesChange}
          localStream={null}
          micEnabled
          onMicEnabledChange={vi.fn()}
          onCameraEnabledChange={vi.fn()}
          onBackToHome={vi.fn()}
        />
      </PremiumContext.Provider>,
    );
    expect(onPreferencesChange).toHaveBeenCalledWith({ genderFilter: "all", languageFilter: "any" });
    const notice = screen.getByTestId("gender-filter-off");
    expect(notice).toHaveTextContent("Gender filter turned off");
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(openUnlockSheet).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("gender-filter-off")).not.toBeInTheDocument();
  });

  it("shows nothing when the server applies the filter that was sent", () => {
    signalingState = { ...initialSignalingState, status: "waiting", coins: 100, genderFilter: "female" };
    const onPreferencesChange = vi.fn();
    render(
      <Room
        profile={profile}
        preferences={{ genderFilter: "female", languageFilter: "any" }}
        onPreferencesChange={onPreferencesChange}
        localStream={null}
        micEnabled
        onMicEnabledChange={vi.fn()}
        onCameraEnabledChange={vi.fn()}
        onBackToHome={vi.fn()}
      />,
    );
    expect(onPreferencesChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("gender-filter-off")).not.toBeInTheDocument();
  });
});

describe("Room Hide my IP fail-closed sheet", () => {
  beforeEach(() => {
    signalingState = inCall();
    peerState = {
      remoteStream: null,
      remoteAudioTrack: null,
      connectionState: "idle",
      connectedAt: null,
      quality: "GOOD",
      ...PEER_EXTRAS,
      privateRequested: true,
      privateBlocked: true,
    };
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("blocks the call behind a sheet whose Skip leaves and whose Continue connects directly", () => {
    renderRoom();
    const sheet = screen.getByTestId("private-unavailable-sheet");
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(sheet).toHaveTextContent("Hide my IP is not available for this call");
    expect(screen.queryByTestId("private-unavailable")).not.toBeInTheDocument();
    expect(screen.queryByTestId("private-badge")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("private-unavailable-continue"));
    expect(continueWithoutPrivate).toHaveBeenCalledTimes(1);
    expect(skip).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("private-unavailable-skip"));
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it("shows the direct-connection chip once the user continued", () => {
    peerState = { ...peerState, privateBlocked: false };
    renderRoom();
    expect(screen.queryByTestId("private-unavailable-sheet")).not.toBeInTheDocument();
    expect(screen.getByTestId("private-unavailable")).toHaveTextContent("You chose to continue without Hide my IP");
  });
});
