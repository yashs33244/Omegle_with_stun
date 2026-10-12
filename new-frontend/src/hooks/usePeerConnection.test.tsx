import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePeerConnection, type PeerConnectionOptions } from "./usePeerConnection";
import { CONNECT_TIMEOUT_MS } from "@/lib/connectivity";
import type { RtcSignal } from "@/lib/protocol";
import type { SignalListener } from "./useSignaling";

const ROOM = "11111111-1111-4111-8111-111111111111";
const STUN = [{ urls: "stun:stun.example" }];
const TURN = [{ urls: "turn:turn.example", username: "u", credential: "c" }];

/**
 * RTCPeerConnection stand-in: setLocalDescription gathers a host candidate at
 * once, the way a real browser starts gathering as soon as the local
 * description is set. Records every configuration it was created with.
 */
class FakePeerConnection {
  static created: RTCConfiguration[] = [];
  connectionState: RTCPeerConnectionState = "new";
  onicecandidate: ((e: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  constructor(config: RTCConfiguration) {
    FakePeerConnection.created.push(config);
  }
  addTrack = vi.fn();
  addTransceiver = vi.fn();
  async createOffer() {
    return { type: "offer" as const, sdp: "offer" };
  }
  async createAnswer() {
    return { type: "answer" as const, sdp: "answer" };
  }
  async setLocalDescription() {
    this.onicecandidate?.({
      candidate: { toJSON: () => ({ candidate: "candidate:1 1 udp 2113937151 192.168.1.20 50000 typ host", sdpMid: "0", sdpMLineIndex: 0 }) },
    });
  }
  async setRemoteDescription() {}
  async addIceCandidate() {}
  async getStats() {
    return new Map();
  }
  close() {
    this.connectionState = "closed";
  }
}

function options(overrides: Partial<PeerConnectionOptions>, sent: RtcSignal[], listeners: Map<string, SignalListener>): PeerConnectionOptions {
  return {
    roomId: ROOM,
    initiator: true,
    iceServers: STUN,
    media: { iceServers: STUN, maxBitrateKbps: 900, relayMaxBitrateKbps: 500, privateModeAllowed: false },
    hideIp: true,
    localStream: null,
    videoPaused: false,
    videoPlaceholder: null,
    sendSignal: (s) => sent.push(s),
    subscribeSignals: (roomId, listener) => {
      listeners.set(roomId, listener);
      return () => listeners.delete(roomId);
    },
    onCallFailed: vi.fn(),
    onTelemetry: vi.fn(),
    onPrivateUnavailableExpired: vi.fn(),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("usePeerConnection with Hide my IP", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakePeerConnection.created = [];
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("creates nothing and sends nothing while the relay is unavailable, until the user continues", async () => {
    const sent: RtcSignal[] = [];
    const listeners = new Map<string, SignalListener>();
    const opts = options({}, sent, listeners);
    const { result } = renderHook(() => usePeerConnection(opts));
    await flush();

    expect(result.current.privateBlocked).toBe(true);
    expect(result.current.privateRequested).toBe(true);
    expect(result.current.privateMode).toBe(false);
    expect(FakePeerConnection.created).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(listeners.size).toBe(0);

    act(() => result.current.continueWithoutPrivate());
    await flush();

    expect(result.current.privateBlocked).toBe(false);
    expect(result.current.privateRequested).toBe(true);
    expect(FakePeerConnection.created).toEqual([{ iceServers: STUN, iceTransportPolicy: "all" }]);
    expect(sent.map((s) => (s.description ? "offer" : "candidate")).sort()).toEqual(["candidate", "offer"]);
    expect(listeners.has(ROOM)).toBe(true);
    expect(opts.onPrivateUnavailableExpired).not.toHaveBeenCalled();
  });

  it("asks to skip the room when the user does not answer within the connect timeout", async () => {
    const sent: RtcSignal[] = [];
    const listeners = new Map<string, SignalListener>();
    const opts = options({}, sent, listeners);
    const { result } = renderHook(() => usePeerConnection(opts));
    await flush();
    expect(result.current.privateBlocked).toBe(true);

    act(() => vi.advanceTimersByTime(CONNECT_TIMEOUT_MS - 1));
    expect(opts.onPrivateUnavailableExpired).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(opts.onPrivateUnavailableExpired).toHaveBeenCalledWith(ROOM);
    expect(FakePeerConnection.created).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  it("blocks when the server allows the relay but offers no TURN server", async () => {
    const sent: RtcSignal[] = [];
    const opts = options({ media: { iceServers: STUN, maxBitrateKbps: 900, relayMaxBitrateKbps: 500, privateModeAllowed: true } }, sent, new Map());
    const { result } = renderHook(() => usePeerConnection(opts));
    await flush();
    expect(result.current.privateBlocked).toBe(true);
    expect(sent).toEqual([]);
  });

  it("connects relay-only straight away when the relay is available", async () => {
    const sent: RtcSignal[] = [];
    const opts = options({ media: { iceServers: TURN, maxBitrateKbps: 900, relayMaxBitrateKbps: 500, privateModeAllowed: true } }, sent, new Map());
    const { result } = renderHook(() => usePeerConnection(opts));
    await flush();
    expect(result.current.privateBlocked).toBe(false);
    expect(result.current.privateMode).toBe(true);
    expect(FakePeerConnection.created).toEqual([{ iceServers: TURN, iceTransportPolicy: "relay" }]);
    expect(sent).toHaveLength(2);
  });

  it("does not block when Hide my IP is off", async () => {
    const sent: RtcSignal[] = [];
    const opts = options({ hideIp: false }, sent, new Map());
    const { result } = renderHook(() => usePeerConnection(opts));
    await flush();
    expect(result.current.privateBlocked).toBe(false);
    expect(result.current.privateRequested).toBe(false);
    expect(FakePeerConnection.created).toEqual([{ iceServers: STUN, iceTransportPolicy: "all" }]);
  });
});
