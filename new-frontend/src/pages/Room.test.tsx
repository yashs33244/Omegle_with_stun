import React, { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Preferences, Profile } from "@/lib/protocol";
import { initialSignalingState, type SignalingState } from "@/hooks/useSignaling";
import type { PeerConnectionState } from "@/hooks/usePeerConnection";

let signalingState: SignalingState;
let peerState: PeerConnectionState;
const skip = vi.fn();

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
      subscribeSignals: vi.fn(() => () => {}),
      retry: vi.fn(),
    }),
  };
});
vi.mock("@/hooks/usePeerConnection", () => ({ usePeerConnection: () => peerState }));
vi.mock("@/hooks/useAudioLevelDetection", () => ({ useAudioLevelDetection: () => ({ isSpeaking: false }) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const { Room } = await import("./Room");

const profile: Profile = { name: "Ana", country: "IN", language: "en", gender: "unspecified", topics: ["music"] };
const preferences: Preferences = { genderFilter: "all", languageFilter: "any" };
const ROOM = "11111111-1111-4111-8111-111111111111";

function inCall(overrides: Partial<SignalingState> = {}): SignalingState {
  return {
    ...initialSignalingState,
    status: "in-call",
    roomId: ROOM,
    initiator: true,
    callStartedAt: Date.now(),
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
    peerState = { remoteStream: null, remoteAudioTrack: null, connectionState: "connected", quality: "GOOD" };
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
