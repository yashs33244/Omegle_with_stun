import { describe, expect, it, vi } from "vitest";
import {
  CONNECT_TIMEOUT_MS,
  ConnectMonitor,
  DISCONNECTED_RESTART_MS,
  LossTracker,
  buildTelemetry,
  hasTurnServer,
  isRelayed,
  parseStunList,
  probeNetwork,
  readConnectionStats,
  rtcConfiguration,
  scaleDownFor,
  videoBitrateKbps,
} from "./connectivity";
import { fakeTimers } from "@/test/fakeTimers";

function monitor() {
  const t = fakeTimers();
  const hooks = { restartIce: vi.fn(), onFailure: vi.fn(), onConnected: vi.fn() };
  const m = new ConnectMonitor(hooks, t.timers);
  m.start();
  return { m, hooks, ...t };
}

describe("ConnectMonitor", () => {
  it("reports a timeout when the call never connects within 10 s", () => {
    const { m, hooks, advance } = monitor();
    m.update("connecting");
    advance(CONNECT_TIMEOUT_MS - 1);
    expect(hooks.onFailure).not.toHaveBeenCalled();
    advance(1);
    expect(hooks.onFailure).toHaveBeenCalledWith("timeout");
    expect(m.outcome).toBe("timeout");
  });

  it("records the time to connect and cancels the timeout", () => {
    const { m, hooks, advance, pendingCount } = monitor();
    advance(2_500);
    m.update("connected");
    expect(hooks.onConnected).toHaveBeenCalledWith(2_500);
    expect(m.timeToConnectMs).toBe(2_500);
    expect(m.outcome).toBe("connected");
    expect(pendingCount()).toBe(0);
    advance(CONNECT_TIMEOUT_MS * 2);
    expect(hooks.onFailure).not.toHaveBeenCalled();
  });

  it("restarts ICE after 4 s in disconnected, not before", () => {
    const { m, hooks, advance } = monitor();
    m.update("connected");
    m.update("disconnected");
    advance(DISCONNECTED_RESTART_MS - 1);
    expect(hooks.restartIce).not.toHaveBeenCalled();
    advance(1);
    expect(hooks.restartIce).toHaveBeenCalledTimes(1);
  });

  it("does not restart when the connection recovers on its own", () => {
    const { m, hooks, advance } = monitor();
    m.update("connected");
    m.update("disconnected");
    advance(2_000);
    m.update("connected");
    advance(DISCONNECTED_RESTART_MS);
    expect(hooks.restartIce).not.toHaveBeenCalled();
  });

  it("retries once on failed, then reports ice-failed", () => {
    const { m, hooks } = monitor();
    m.update("connected");
    m.update("failed");
    expect(hooks.restartIce).toHaveBeenCalledTimes(1);
    expect(hooks.onFailure).not.toHaveBeenCalled();
    m.update("connecting");
    m.update("failed");
    expect(hooks.restartIce).toHaveBeenCalledTimes(1);
    expect(hooks.onFailure).toHaveBeenCalledWith("ice-failed");
    expect(m.outcome).toBe("ice-failed");
  });

  it("reports ice-failed when the retry never recovers", () => {
    const { m, hooks, advance } = monitor();
    m.update("connected");
    m.update("failed");
    advance(CONNECT_TIMEOUT_MS);
    expect(hooks.onFailure).toHaveBeenCalledWith("ice-failed");
  });

  it("keeps the call when the retry succeeds", () => {
    const { m, hooks, advance } = monitor();
    m.update("connected");
    m.update("failed");
    m.update("connected");
    advance(CONNECT_TIMEOUT_MS * 2);
    expect(hooks.onFailure).not.toHaveBeenCalled();
    expect(m.outcome).toBe("connected");
  });

  it("reports at most once and goes quiet after stop()", () => {
    const { m, hooks, advance } = monitor();
    advance(CONNECT_TIMEOUT_MS);
    m.update("failed");
    m.update("failed");
    expect(hooks.onFailure).toHaveBeenCalledTimes(1);

    const second = monitor();
    second.m.stop();
    second.advance(CONNECT_TIMEOUT_MS * 2);
    second.m.update("failed");
    expect(second.hooks.onFailure).not.toHaveBeenCalled();
  });
});

/** Builds an RTCStatsReport-like map. */
function report(entries: Array<Record<string, unknown> & { id: string; type: string }>): RTCStatsReport {
  return new Map(entries.map((e) => [e.id, e])) as unknown as RTCStatsReport;
}

describe("readConnectionStats", () => {
  it("reads the selected pair, candidate types, rtt, loss and freezes", () => {
    const stats = readConnectionStats(
      report([
        { id: "T1", type: "transport", selectedCandidatePairId: "P1" },
        { id: "P1", type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R1", currentRoundTripTime: 0.12, state: "succeeded" },
        { id: "P2", type: "candidate-pair", localCandidateId: "L2", remoteCandidateId: "R1", nominated: true, state: "succeeded" },
        { id: "L1", type: "local-candidate", candidateType: "relay" },
        { id: "L2", type: "local-candidate", candidateType: "host" },
        { id: "R1", type: "remote-candidate", candidateType: "srflx" },
        { id: "I1", type: "inbound-rtp", kind: "video", packetsReceived: 900, packetsLost: 100, freezeCount: 2 },
        { id: "I2", type: "inbound-rtp", kind: "audio", packetsReceived: 100, packetsLost: 0 },
        { id: "RI", type: "remote-inbound-rtp", kind: "video", fractionLost: 0.25 },
      ]),
    );
    expect(stats).toEqual({
      localCandidateType: "relay",
      remoteCandidateType: "srflx",
      rttMs: 120,
      packetsReceived: 1000,
      packetsLost: 100,
      freezeCount: 2,
      remoteFractionLost: 0.25,
    });
    expect(isRelayed(stats)).toBe(true);
  });

  it("falls back to the nominated pair and maps unknown types", () => {
    const stats = readConnectionStats(
      report([
        { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R", nominated: true, state: "succeeded" },
        { id: "L", type: "local-candidate", candidateType: "host" },
        { id: "R", type: "remote-candidate", candidateType: "weird" },
      ]),
    );
    expect(stats.localCandidateType).toBe("host");
    expect(stats.remoteCandidateType).toBe("unknown");
    expect(isRelayed(stats)).toBe(false);
  });
});

describe("telemetry", () => {
  it("builds a connected call payload", () => {
    const payload = buildTelemetry({
      roomId: "r",
      outcome: "connected",
      timeToConnectMs: 1234.4,
      connectedAt: 10_000,
      endedAt: 70_000,
      privateMode: true,
      stats: { localCandidateType: "relay", remoteCandidateType: "host", rttMs: 80, packetsReceived: 990, packetsLost: 10, freezeCount: 1 },
    });
    expect(payload).toEqual({
      roomId: "r",
      outcome: "connected",
      timeToConnectMs: 1234,
      durationMs: 60_000,
      privateMode: true,
      localCandidateType: "relay",
      remoteCandidateType: "host",
      rttMs: 80,
      packetLossPct: 1,
      freezeCount: 1,
    });
  });

  it("marks a call that ended while connecting", () => {
    expect(
      buildTelemetry({ roomId: "r", outcome: "pending", timeToConnectMs: null, connectedAt: null, endedAt: 5, privateMode: false, stats: null }),
    ).toEqual({ roomId: "r", outcome: "ended-before-connect", privateMode: false });
  });

  it("keeps failure outcomes", () => {
    expect(
      buildTelemetry({ roomId: "r", outcome: "timeout", timeToConnectMs: null, connectedAt: null, endedAt: 5, privateMode: false, stats: null }).outcome,
    ).toBe("timeout");
  });
});

describe("bitrate and low bandwidth", () => {
  const caps = { maxBitrateKbps: 900, relayMaxBitrateKbps: 500 };

  it("picks the relay cap for relayed calls and 400 kbps in low-bandwidth mode", () => {
    expect(videoBitrateKbps(caps, false, false)).toBe(900);
    expect(videoBitrateKbps(caps, true, false)).toBe(500);
    expect(videoBitrateKbps(caps, false, true)).toBe(400);
    expect(videoBitrateKbps({ maxBitrateKbps: 300, relayMaxBitrateKbps: 300 }, true, true)).toBe(300);
  });

  it("scales tracks down to about 360p", () => {
    expect(scaleDownFor(720)).toBe(2);
    expect(scaleDownFor(360)).toBe(1);
    expect(scaleDownFor(undefined)).toBe(1);
  });

  it("steps down once after three bad samples in a row", () => {
    const t = new LossTracker();
    const sample = (received: number, lost: number) => ({ packetsReceived: received, packetsLost: lost });
    expect(t.push(sample(100, 0))).toBe(false);
    expect(t.push(sample(180, 20))).toBe(false); // 20% loss
    expect(t.push(sample(200, 20))).toBe(false); // recovered: streak resets
    expect(t.push(sample(280, 40))).toBe(false);
    expect(t.push(sample(360, 60))).toBe(false);
    expect(t.push(sample(440, 80))).toBe(true);
    expect(t.steppedDown).toBe(true);
    expect(t.push(sample(520, 100))).toBe(false);
  });

  it("counts loss the partner reports for our video", () => {
    const t = new LossTracker();
    const s = { packetsReceived: 0, packetsLost: 0, remoteFractionLost: 0.3 };
    expect([t.push(s), t.push(s), t.push(s)]).toEqual([false, false, true]);
  });
});

describe("ICE configuration", () => {
  const servers = [{ urls: "stun:s.example" }, { urls: ["turn:t.example:3478", "turns:t.example:443"], username: "u", credential: "c" }];

  it("forces the relay in private mode", () => {
    expect(rtcConfiguration(servers, true).iceTransportPolicy).toBe("relay");
    expect(rtcConfiguration(servers, false).iceTransportPolicy).toBe("all");
    expect(rtcConfiguration(servers, false).iceServers).toBe(servers);
  });

  it("detects TURN servers", () => {
    expect(hasTurnServer(servers)).toBe(true);
    expect(hasTurnServer([{ urls: "stun:s.example" }])).toBe(false);
  });

  it("parses a STUN list", () => {
    expect(parseStunList(" stun:a:1, stun:b:2 ,")).toEqual([{ urls: ["stun:a:1", "stun:b:2"] }]);
    expect(parseStunList("")).toEqual([]);
    expect(parseStunList(undefined)).toEqual([]);
  });
});

describe("probeNetwork", () => {
  function fakePc(candidates: Array<string | null>) {
    const pc = {
      onicecandidate: null as ((e: { candidate: { type?: string; candidate: string } | null }) => void) | null,
      createDataChannel: vi.fn(),
      createOffer: vi.fn(async () => ({ type: "offer", sdp: "x" })),
      setLocalDescription: vi.fn(async () => {
        for (const c of candidates) pc.onicecandidate?.({ candidate: c === null ? null : { candidate: `candidate:1 1 udp 1 1.2.3.4 5 typ ${c}` } });
      }),
      close: vi.fn(),
    };
    return pc;
  }

  it("reports which candidate kinds were gathered", async () => {
    const pc = fakePc(["host", "srflx", "relay", null]);
    const result = await probeNetwork([{ urls: "turn:t", username: "u", credential: "c" }], {
      createPeerConnection: () => pc as unknown as RTCPeerConnection,
    });
    expect(result).toEqual({ host: true, srflx: true, relay: true });
    expect(pc.close).toHaveBeenCalled();
  });

  it("says the relay was not tested without a TURN server, and stops after the duration", async () => {
    const pc = fakePc(["host"]);
    const t = fakeTimers();
    const pending = probeNetwork([], { createPeerConnection: () => pc as unknown as RTCPeerConnection, timers: t.timers, durationMs: 2000 });
    await Promise.resolve();
    await Promise.resolve();
    t.advance(2000);
    await expect(pending).resolves.toEqual({ host: true, srflx: false, relay: null });
  });
});
