/**
 * Connection reliability for one call: the connect timeout, ICE restarts,
 * bitrate caps, low-bandwidth step-down, call telemetry and the pre-flight
 * network probe. Everything here is plain logic with injectable timers and
 * peer connections, so it is unit tested without a browser.
 */
import type { CallTelemetryPayload, IceServer } from "./protocol";

/** The call must reach "connected" within this time or it is reported as failed. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** How long "disconnected" may last before an ICE restart. */
export const DISCONNECTED_RESTART_MS = 4_000;
/** Low-bandwidth mode: about 360p at this bitrate. */
export const LOW_BANDWIDTH_KBPS = 400;
export const LOW_BANDWIDTH_HEIGHT = 360;
/** Packet loss (0..1) that counts as a bad sample, and how many bad samples in a row trigger the step-down. */
export const LOSS_STEP_DOWN_THRESHOLD = 0.08;
export const LOSS_STEP_DOWN_SAMPLES = 3;

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

export const browserTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/* ------------------------------------------------------------------ */
/* Connect monitor                                                     */
/* ------------------------------------------------------------------ */

export type ConnectFailure = "timeout" | "ice-failed";
export type ConnectOutcome = "pending" | "connected" | ConnectFailure;

export interface ConnectMonitorHooks {
  /** Ask the peer session for an ICE restart. */
  restartIce: () => void;
  /** Called once when the call cannot be (re)established. */
  onFailure: (reason: ConnectFailure) => void;
  /** Called once, the first time the connection comes up. */
  onConnected?: (timeToConnectMs: number) => void;
}

/**
 * Watches RTCPeerConnection.connectionState for one call:
 * - not connected within 10 s of start: failure "timeout";
 * - "disconnected" for 4 s: restartIce();
 * - "failed": one restartIce(); a second "failed", or no recovery within 10 s, is failure "ice-failed".
 */
export class ConnectMonitor {
  private readonly hooks: ConnectMonitorHooks;
  private readonly timers: Timers;
  private startedAt = 0;
  private connectTimer: unknown = null;
  private disconnectTimer: unknown = null;
  private recoveryTimer: unknown = null;
  private retried = false;
  private state: RTCPeerConnectionState = "new";
  private _outcome: ConnectOutcome = "pending";
  private _everConnected = false;
  private _timeToConnectMs: number | null = null;
  private _connectedAt: number | null = null;
  private _restarts = 0;
  private stopped = false;

  constructor(hooks: ConnectMonitorHooks, timers: Timers = browserTimers) {
    this.hooks = hooks;
    this.timers = timers;
  }

  get outcome(): ConnectOutcome {
    return this._outcome;
  }
  get everConnected(): boolean {
    return this._everConnected;
  }
  get timeToConnectMs(): number | null {
    return this._timeToConnectMs;
  }
  get connectedAt(): number | null {
    return this._connectedAt;
  }
  get restarts(): number {
    return this._restarts;
  }

  start(): void {
    this.startedAt = this.timers.now();
    this.connectTimer = this.timers.setTimeout(() => {
      this.connectTimer = null;
      if (!this._everConnected) this.fail("timeout");
    }, CONNECT_TIMEOUT_MS);
  }

  update(state: RTCPeerConnectionState): void {
    if (this.stopped) return;
    this.state = state;
    switch (state) {
      case "connected":
        this.clear("connectTimer");
        this.clear("disconnectTimer");
        this.clear("recoveryTimer");
        if (!this._everConnected) {
          this._everConnected = true;
          this._connectedAt = this.timers.now();
          this._timeToConnectMs = this._connectedAt - this.startedAt;
          this._outcome = "connected";
          this.hooks.onConnected?.(this._timeToConnectMs);
        }
        break;
      case "disconnected":
        if (this.disconnectTimer === null) {
          this.disconnectTimer = this.timers.setTimeout(() => {
            this.disconnectTimer = null;
            if (this.state === "disconnected" && !this.stopped) this.restart();
          }, DISCONNECTED_RESTART_MS);
        }
        break;
      case "failed":
        this.clear("disconnectTimer");
        if (this.retried) {
          this.fail("ice-failed");
        } else {
          this.retried = true;
          this.restart();
          this.recoveryTimer = this.timers.setTimeout(() => {
            this.recoveryTimer = null;
            if (this.state !== "connected") this.fail("ice-failed");
          }, CONNECT_TIMEOUT_MS);
        }
        break;
      case "closed":
        this.stop();
        break;
      default:
        break;
    }
  }

  stop(): void {
    this.stopped = true;
    this.clear("connectTimer");
    this.clear("disconnectTimer");
    this.clear("recoveryTimer");
  }

  private restart(): void {
    this._restarts += 1;
    this.hooks.restartIce();
  }

  private fail(reason: ConnectFailure): void {
    if (this.stopped) return;
    this.stop();
    // A call that connected once and then broke is still reported as an ICE failure.
    this._outcome = reason;
    this.hooks.onFailure(reason);
  }

  private clear(key: "connectTimer" | "disconnectTimer" | "recoveryTimer"): void {
    if (this[key] !== null) this.timers.clearTimeout(this[key]);
    this[key] = null;
  }
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

export type CandidateType = NonNullable<CallTelemetryPayload["localCandidateType"]>;

export interface ConnectionStats {
  localCandidateType?: CandidateType;
  remoteCandidateType?: CandidateType;
  /** Selected candidate pair round trip time. */
  rttMs?: number;
  /** Cumulative inbound counters (all kinds). */
  packetsReceived: number;
  packetsLost: number;
  /** Latest fraction (0..1) of our outgoing video the partner reported lost. */
  remoteFractionLost?: number;
  /** Inbound video freezes (Chrome only). */
  freezeCount?: number;
}

function candidateType(value: unknown): CandidateType {
  return value === "host" || value === "srflx" || value === "prflx" || value === "relay" ? value : "unknown";
}

type StatsEntry = Record<string, unknown> & { id: string; type: string };

/** Pulls the selected candidate pair, RTT, loss and freezes out of an RTCStatsReport. */
export function readConnectionStats(report: RTCStatsReport): ConnectionStats {
  const byId = new Map<string, StatsEntry>();
  report.forEach((s: StatsEntry) => byId.set(s.id, s));

  let pair: StatsEntry | undefined;
  for (const s of byId.values()) {
    if (s.type === "transport" && typeof s.selectedCandidatePairId === "string") {
      pair = byId.get(s.selectedCandidatePairId);
      if (pair) break;
    }
  }
  if (!pair) {
    for (const s of byId.values()) {
      if (s.type === "candidate-pair" && (s.selected || s.nominated) && s.state === "succeeded") {
        pair = s;
        break;
      }
    }
  }

  const out: ConnectionStats = { packetsReceived: 0, packetsLost: 0 };
  if (pair) {
    const local = byId.get(String(pair.localCandidateId));
    const remote = byId.get(String(pair.remoteCandidateId));
    if (local) out.localCandidateType = candidateType(local.candidateType);
    if (remote) out.remoteCandidateType = candidateType(remote.candidateType);
    if (typeof pair.currentRoundTripTime === "number") out.rttMs = pair.currentRoundTripTime * 1000;
  }
  for (const s of byId.values()) {
    if (s.type === "inbound-rtp") {
      out.packetsReceived += Number(s.packetsReceived ?? 0);
      out.packetsLost += Math.max(0, Number(s.packetsLost ?? 0));
      if (s.kind === "video" && typeof s.freezeCount === "number") {
        out.freezeCount = (out.freezeCount ?? 0) + s.freezeCount;
      }
    } else if (s.type === "remote-inbound-rtp" && s.kind === "video" && typeof s.fractionLost === "number") {
      out.remoteFractionLost = s.fractionLost;
    }
  }
  return out;
}

export function isRelayed(stats: Pick<ConnectionStats, "localCandidateType" | "remoteCandidateType">): boolean {
  return stats.localCandidateType === "relay" || stats.remoteCandidateType === "relay";
}

/** Inbound packet loss (0..1) between two samples. */
export function lossBetween(current: ConnectionStats, previous: ConnectionStats | null): number {
  const received = current.packetsReceived - (previous?.packetsReceived ?? 0);
  const lost = Math.max(0, current.packetsLost - (previous?.packetsLost ?? 0));
  return received + lost > 0 ? lost / (received + lost) : 0;
}

/**
 * Decides when to drop to low-bandwidth mode: several bad samples in a row,
 * judged on the worse of what we receive and what the partner reports for our video.
 */
export class LossTracker {
  private badStreak = 0;
  private previous: ConnectionStats | null = null;
  private _steppedDown = false;

  get steppedDown(): boolean {
    return this._steppedDown;
  }

  /** Returns true exactly once, on the sample that triggers the step-down. */
  push(sample: ConnectionStats): boolean {
    const loss = Math.max(lossBetween(sample, this.previous), sample.remoteFractionLost ?? 0);
    this.previous = sample;
    if (this._steppedDown) return false;
    this.badStreak = loss >= LOSS_STEP_DOWN_THRESHOLD ? this.badStreak + 1 : 0;
    if (this.badStreak >= LOSS_STEP_DOWN_SAMPLES) {
      this._steppedDown = true;
      return true;
    }
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Bitrate                                                             */
/* ------------------------------------------------------------------ */

export interface BitrateCaps {
  maxBitrateKbps: number;
  relayMaxBitrateKbps: number;
}

export function videoBitrateKbps(caps: BitrateCaps, relayed: boolean, lowBandwidth: boolean): number {
  const base = relayed ? caps.relayMaxBitrateKbps : caps.maxBitrateKbps;
  return lowBandwidth ? Math.min(base, LOW_BANDWIDTH_KBPS) : base;
}

/** Scale factor that brings a track of this height down to about 360p (1 = unchanged). */
export function scaleDownFor(height: number | undefined, target = LOW_BANDWIDTH_HEIGHT): number {
  if (!height || height <= target) return 1;
  return height / target;
}

/** Applies maxBitrate (and optionally a resolution scale) to a video sender. Best effort. */
export async function applyVideoSenderLimits(
  sender: RTCRtpSender,
  maxBitrateKbps: number,
  scaleResolutionDownBy?: number,
): Promise<boolean> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) return false;
    params.encodings = params.encodings.map((e) => ({
      ...e,
      maxBitrate: maxBitrateKbps * 1000,
      ...(scaleResolutionDownBy !== undefined ? { scaleResolutionDownBy } : {}),
    }));
    await sender.setParameters(params);
    return true;
  } catch {
    // Not negotiated yet, or the browser refused; the next stats tick tries again.
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Telemetry                                                           */
/* ------------------------------------------------------------------ */

export interface TelemetryInput {
  roomId: string;
  outcome: ConnectOutcome;
  timeToConnectMs: number | null;
  connectedAt: number | null;
  endedAt: number;
  privateMode: boolean;
  stats: ConnectionStats | null;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** The call:telemetry payload sent once when a call ends. No IPs, no content. */
export function buildTelemetry(input: TelemetryInput): CallTelemetryPayload {
  const { stats } = input;
  const outcome: CallTelemetryPayload["outcome"] = input.outcome === "pending" ? "ended-before-connect" : input.outcome;
  const payload: CallTelemetryPayload = { roomId: input.roomId, outcome, privateMode: input.privateMode };
  if (input.timeToConnectMs !== null) payload.timeToConnectMs = clamp(Math.round(input.timeToConnectMs), 0, 600_000);
  if (input.connectedAt !== null) payload.durationMs = clamp(Math.round(input.endedAt - input.connectedAt), 0, 86_400_000);
  if (stats) {
    if (stats.localCandidateType) payload.localCandidateType = stats.localCandidateType;
    if (stats.remoteCandidateType) payload.remoteCandidateType = stats.remoteCandidateType;
    if (stats.rttMs !== undefined) payload.rttMs = clamp(stats.rttMs, 0, 60_000);
    const total = stats.packetsReceived + stats.packetsLost;
    if (total > 0) payload.packetLossPct = clamp((stats.packetsLost / total) * 100, 0, 100);
    if (stats.freezeCount !== undefined) payload.freezeCount = clamp(Math.round(stats.freezeCount), 0, 100_000);
  }
  return payload;
}

/* ------------------------------------------------------------------ */
/* ICE configuration                                                   */
/* ------------------------------------------------------------------ */

/** "Hide my IP" sends everything through the relay; otherwise any path is allowed. */
export function rtcConfiguration(iceServers: IceServer[], privateMode: boolean): RTCConfiguration {
  return {
    iceServers: iceServers as RTCIceServer[],
    iceTransportPolicy: privateMode ? "relay" : "all",
  };
}

export function hasTurnServer(iceServers: IceServer[]): boolean {
  return iceServers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(u)));
}

/* ------------------------------------------------------------------ */
/* Pre-flight network probe                                            */
/* ------------------------------------------------------------------ */

export interface NetworkProbeResult {
  /** A local candidate was gathered: WebRTC works at all. */
  host: boolean;
  /** A STUN (server reflexive) candidate: direct connections are likely to work. */
  srflx: boolean;
  /** A relay candidate; null when no relay server was available to test. */
  relay: boolean | null;
}

export interface ProbeOptions {
  durationMs?: number;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  timers?: Timers;
}

/**
 * Gathers candidates on a throwaway RTCPeerConnection for about 2 s and reports
 * which kinds showed up. Nothing is sent to anyone but the STUN/TURN servers.
 */
export async function probeNetwork(iceServers: IceServer[], opts: ProbeOptions = {}): Promise<NetworkProbeResult> {
  const { durationMs = 2000, timers = browserTimers } = opts;
  const create = opts.createPeerConnection ?? ((config) => new RTCPeerConnection(config));
  const pc = create({ iceServers: iceServers as RTCIceServer[] });
  const result: NetworkProbeResult = { host: false, srflx: false, relay: hasTurnServer(iceServers) ? false : null };
  try {
    await new Promise<void>((resolve) => {
      const timer = timers.setTimeout(resolve, durationMs);
      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          timers.clearTimeout(timer);
          resolve();
          return;
        }
        const type = e.candidate.type ?? /\btyp (\w+)/.exec(e.candidate.candidate)?.[1];
        if (type === "host") result.host = true;
        else if (type === "srflx" || type === "prflx") result.srflx = true;
        else if (type === "relay") result.relay = true;
      };
      pc.createDataChannel("probe");
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => {
          timers.clearTimeout(timer);
          resolve();
        });
    });
  } finally {
    pc.onicecandidate = null;
    pc.close();
  }
  return result;
}

/** Turns a VITE_PROBE_STUN_URLS style comma-separated list into ICE servers. */
export function parseStunList(raw: string | undefined): IceServer[] {
  const urls = (raw ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  return urls.length > 0 ? [{ urls }] : [];
}
