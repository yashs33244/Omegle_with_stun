import { describe, expect, it, vi } from "vitest";
import { PeerSession, qualityFromStats, readStats } from "./peerSession";
import type { RtcSignal } from "./protocol";

const ROOM = "11111111-1111-4111-8111-111111111111";

/** Minimal RTCPeerConnection stand-in that records calls. */
class FakePeerConnection {
  signalingState: RTCSignalingState = "stable";
  connectionState: RTCPeerConnectionState = "new";
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  added: RTCIceCandidateInit[] = [];
  calls: string[] = [];
  closed = false;
  onicecandidate: ((e: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
  ontrack: ((e: { track: unknown; streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  /** Resolves setRemoteDescription when called, letting tests control timing. */
  releaseRemote: (() => void) | null = null;
  holdRemote = false;

  addTrack = vi.fn();
  addTransceiver = vi.fn();

  async createOffer() {
    this.calls.push("createOffer");
    return { type: "offer" as const, sdp: "offer-sdp" };
  }
  async createAnswer() {
    this.calls.push("createAnswer");
    return { type: "answer" as const, sdp: "answer-sdp" };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.calls.push(`setLocal:${d.type}`);
    this.localDescription = d;
    this.signalingState = d.type === "offer" ? "have-local-offer" : "stable";
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.calls.push(`setRemote:${d.type}`);
    if (this.holdRemote) await new Promise<void>((r) => (this.releaseRemote = r));
    this.remoteDescription = d;
    this.signalingState = d.type === "offer" ? "have-remote-offer" : "stable";
  }
  async addIceCandidate(c: RTCIceCandidateInit) {
    if (!this.remoteDescription) throw new Error("InvalidStateError: no remote description");
    this.calls.push(`addIce:${c.candidate}`);
    this.added.push(c);
  }
  close() {
    this.closed = true;
  }
}

function setup(initiator: boolean, localStream: MediaStream | null = null) {
  const fake = new FakePeerConnection();
  const sent: RtcSignal[] = [];
  const session = new PeerSession({
    roomId: ROOM,
    initiator,
    iceServers: [{ urls: "stun:stun.example.com" }],
    localStream,
    sendSignal: (s) => sent.push(s),
    onRemoteStream: vi.fn(),
    onConnectionStateChange: vi.fn(),
    createPeerConnection: () => fake as unknown as RTCPeerConnection,
  });
  return { fake, sent, session };
}

const candidate = (n: number): RtcSignal => ({
  roomId: ROOM,
  candidate: { candidate: `candidate:${n}`, sdpMid: "0", sdpMLineIndex: 0 },
});

describe("PeerSession", () => {
  it("initiator creates and sends exactly one offer", async () => {
    const { fake, sent, session } = setup(true);
    await session.start();
    expect(fake.calls).toEqual(["createOffer", "setLocal:offer"]);
    expect(sent).toEqual([{ roomId: ROOM, description: { type: "offer", sdp: "offer-sdp" } }]);
  });

  it("the answering side never offers and answers an incoming offer", async () => {
    const { fake, sent, session } = setup(false);
    await session.start();
    expect(sent).toEqual([]);
    await session.handleSignal({ roomId: ROOM, description: { type: "offer", sdp: "remote-offer" } });
    expect(fake.calls).toEqual(["setRemote:offer", "createAnswer", "setLocal:answer"]);
    expect(sent).toEqual([{ roomId: ROOM, description: { type: "answer", sdp: "answer-sdp" } }]);
  });

  it("queues ICE candidates until the remote description is set, then flushes them in order", async () => {
    const { fake, session } = setup(false);
    await session.handleSignal(candidate(1));
    await session.handleSignal(candidate(2));
    expect(session.queuedCandidateCount).toBe(2);
    expect(fake.added).toEqual([]);

    await session.handleSignal({ roomId: ROOM, description: { type: "offer", sdp: "remote-offer" } });
    expect(session.queuedCandidateCount).toBe(0);
    expect(fake.added.map((c) => c.candidate)).toEqual(["candidate:1", "candidate:2"]);
    // Flushed right after the remote description, before answering.
    expect(fake.calls.slice(0, 3)).toEqual(["setRemote:offer", "addIce:candidate:1", "addIce:candidate:2"]);

    await session.handleSignal(candidate(3));
    expect(fake.added.map((c) => c.candidate)).toEqual(["candidate:1", "candidate:2", "candidate:3"]);
  });

  it("queues candidates that arrive while setRemoteDescription is still pending", async () => {
    const { fake, session } = setup(false);
    fake.holdRemote = true;
    const offer = session.handleSignal({ roomId: ROOM, description: { type: "offer", sdp: "o" } });
    const ice = session.handleSignal(candidate(7));
    await vi.waitFor(() => expect(fake.releaseRemote).not.toBeNull());
    expect(fake.added).toEqual([]);
    fake.releaseRemote?.();
    await Promise.all([offer, ice]);
    expect(fake.added.map((c) => c.candidate)).toEqual(["candidate:7"]);
  });

  it("initiator queues candidates until the answer arrives", async () => {
    const { fake, session } = setup(true);
    await session.start();
    await session.handleSignal(candidate(1));
    expect(session.queuedCandidateCount).toBe(1);
    await session.handleSignal({ roomId: ROOM, description: { type: "answer", sdp: "a" } });
    expect(fake.added.map((c) => c.candidate)).toEqual(["candidate:1"]);
  });

  it("ignores signals for another room and offers sent to the initiator", async () => {
    const { fake, session } = setup(true);
    await session.start();
    await session.handleSignal({ ...candidate(1), roomId: "22222222-2222-4222-8222-222222222222" });
    await session.handleSignal({ roomId: ROOM, description: { type: "offer", sdp: "glare" } });
    expect(session.queuedCandidateCount).toBe(0);
    expect(fake.calls).toEqual(["createOffer", "setLocal:offer"]);
  });

  it("sends local ICE candidates for the room and skips end-of-candidates", () => {
    const { fake, sent } = setup(true);
    fake.onicecandidate?.({ candidate: null });
    fake.onicecandidate?.({
      candidate: { toJSON: () => ({ candidate: "candidate:9", sdpMid: "0", sdpMLineIndex: 0 }) },
    });
    expect(sent).toEqual([
      {
        roomId: ROOM,
        candidate: { candidate: "candidate:9", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null },
      },
    ]);
  });

  it("asks for receive-only media when there is no local stream", () => {
    const { fake } = setup(true);
    expect(fake.addTransceiver).toHaveBeenCalledWith("audio", { direction: "recvonly" });
    expect(fake.addTransceiver).toHaveBeenCalledWith("video", { direction: "recvonly" });
  });

  it("sends a camera-only stream and still receives the partner's audio", () => {
    const video = { kind: "video" };
    const stream = {
      getTracks: () => [video],
      getAudioTracks: () => [],
      getVideoTracks: () => [video],
    } as unknown as MediaStream;
    const { fake } = setup(true, stream);
    expect(fake.addTrack).toHaveBeenCalledWith(video, stream);
    expect(fake.addTransceiver).toHaveBeenCalledTimes(1);
    expect(fake.addTransceiver).toHaveBeenCalledWith("audio", { direction: "recvonly" });
  });

  it("close() closes the connection and drops later signals", async () => {
    const { fake, sent, session } = setup(false);
    session.close();
    expect(fake.closed).toBe(true);
    await session.handleSignal({ roomId: ROOM, description: { type: "offer", sdp: "o" } });
    expect(fake.calls).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("connection quality", () => {
  it("maps RTT and loss to levels", () => {
    const base = { packetsReceived: 0, packetsLost: 0 };
    expect(qualityFromStats({ ...base, rtt: 0.05 }, null)).toBe("EXCELLENT");
    expect(qualityFromStats({ ...base, rtt: 0.2 }, null)).toBe("GOOD");
    expect(qualityFromStats({ ...base, rtt: 0.4 }, null)).toBe("FAIR");
    expect(qualityFromStats({ ...base, rtt: 0.9 }, null)).toBe("POOR");
    expect(qualityFromStats({ rtt: null, packetsReceived: 0, packetsLost: 0 }, null)).toBe("EXCELLENT");
  });

  it("uses packet loss since the previous sample", () => {
    const prev = { rtt: 0.05, packetsReceived: 1000, packetsLost: 500 };
    expect(qualityFromStats({ rtt: 0.05, packetsReceived: 1100, packetsLost: 500 }, prev)).toBe("EXCELLENT");
    expect(qualityFromStats({ rtt: 0.05, packetsReceived: 1080, packetsLost: 520 }, prev)).toBe("POOR");
    expect(qualityFromStats({ rtt: 0.05, packetsReceived: 1093, packetsLost: 507 }, prev)).toBe("FAIR");
  });

  it("reads the selected candidate pair and inbound counters", () => {
    const entries = [
      { type: "candidate-pair", nominated: true, state: "succeeded", currentRoundTripTime: 0.12 },
      { type: "candidate-pair", nominated: false, state: "failed", currentRoundTripTime: 9 },
      { type: "inbound-rtp", packetsReceived: 100, packetsLost: 2 },
      { type: "inbound-rtp", packetsReceived: 50, packetsLost: 1 },
    ];
    const report = { forEach: (cb: (s: unknown) => void) => entries.forEach(cb) } as unknown as RTCStatsReport;
    expect(readStats(report)).toEqual({ rtt: 0.12, packetsReceived: 150, packetsLost: 3 });
  });
});
