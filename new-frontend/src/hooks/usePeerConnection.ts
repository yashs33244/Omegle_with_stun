import { useEffect, useRef, useState } from "react";
import type { CallTelemetryPayload, IceServer, RtcSignal } from "@/lib/protocol";
import {
  ConnectMonitor,
  LossTracker,
  applyVideoSenderLimits,
  buildTelemetry,
  hasTurnServer,
  isRelayed,
  readConnectionStats,
  scaleDownFor,
  videoBitrateKbps,
  type ConnectFailure,
  type ConnectionStats,
} from "@/lib/connectivity";
import {
  PeerSession,
  qualityFromStats,
  readStats,
  type ConnectionQuality,
  type StatsSample,
} from "@/lib/peerSession";
import type { CallMedia, SignalListener } from "./useSignaling";

const STATS_INTERVAL_MS = 2000;
const DEFAULT_CAPS = { maxBitrateKbps: 900, relayMaxBitrateKbps: 500 };

export interface PeerConnectionOptions {
  /** The current room while in a call, otherwise null. */
  roomId: string | null;
  /** From call:start; null until then. */
  initiator: boolean | null;
  /** STUN list from the hello ack; only used when call:start carried no ICE servers. */
  iceServers: IceServer[];
  /** call:start media: per-call ICE servers (with TURN), bitrate caps, Hide my IP permission. */
  media: CallMedia | null;
  /** The user asked for Hide my IP (applies when the call starts and the server allows it). */
  hideIp: boolean;
  localStream: MediaStream | null;
  /** The face gate paused our video: send the placeholder instead of the camera. */
  videoPaused: boolean;
  videoPlaceholder: MediaStreamTrack | null;
  sendSignal: (signal: RtcSignal) => void;
  subscribeSignals: (roomId: string, listener: SignalListener) => () => void;
  /** The call could not connect (10 s timeout or ICE failure after one retry). */
  onCallFailed: (roomId: string, reason: ConnectFailure) => void;
  /** Sent once when the call ends. */
  onTelemetry: (payload: CallTelemetryPayload) => void;
}

export interface PeerConnectionState {
  remoteStream: MediaStream | null;
  /** First audio track of the remote stream, for the speaking indicator. */
  remoteAudioTrack: MediaStreamTrack | null;
  connectionState: RTCPeerConnectionState | "idle";
  /** Local time the connection first reached "connected" in this call; null until then. */
  connectedAt: number | null;
  quality: ConnectionQuality;
  /** Set when the call gave up connecting; the server re-queues both sides. */
  failure: ConnectFailure | null;
  /** This call runs relay-only (Hide my IP). */
  privateMode: boolean;
  /** Hide my IP was on when this call started (it may still have been unavailable). */
  privateRequested: boolean;
  /** The selected path goes through the TURN relay. */
  relayed: boolean;
  /** Sustained packet loss: sending about 360p at 400 kbps. */
  lowBandwidth: boolean;
}

/**
 * Exactly one RTCPeerConnection per call: created when a room has an
 * initiator (call:start), closed when the room ends, a new call starts,
 * or the component unmounts. Also runs the connect timeout and ICE restarts,
 * applies the bitrate caps, steps down on sustained loss and reports
 * telemetry when the call ends.
 */
export function usePeerConnection(opts: PeerConnectionOptions): PeerConnectionState {
  const { roomId, initiator, sendSignal, subscribeSignals } = opts;
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  // ontrack reuses one MediaStream per call; this re-renders when tracks are added to it.
  const [remoteAudioTrack, setRemoteAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [connectionState, setConnectionState] = useState<PeerConnectionState["connectionState"]>("idle");
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [quality, setQuality] = useState<ConnectionQuality>("GOOD");
  const [failure, setFailure] = useState<ConnectFailure | null>(null);
  const [privateMode, setPrivateMode] = useState(false);
  const [privateRequested, setPrivateRequested] = useState(false);
  const [relayed, setRelayed] = useState(false);
  const [lowBandwidth, setLowBandwidth] = useState(false);

  // Read when the call starts; changing them mid-call does not rebuild the connection.
  const latest = useRef(opts);
  latest.current = opts;
  const sessionRef = useRef<PeerSession | null>(null);

  useEffect(() => {
    if (!roomId || initiator === null) return;
    const o = latest.current;
    const iceServers = o.media?.iceServers.length ? o.media.iceServers : o.iceServers;
    // Relay-only needs a relay: without TURN credentials it could never connect.
    const isPrivate = o.hideIp && !!o.media?.privateModeAllowed && hasTurnServer(iceServers);
    const caps = o.media ?? DEFAULT_CAPS;

    const monitor = new ConnectMonitor({
      restartIce: () => void session.restartIce(),
      onFailure: (reason) => {
        setFailure(reason);
        latest.current.onCallFailed(roomId, reason);
      },
    });

    const session = new PeerSession({
      roomId,
      initiator,
      iceServers,
      privateMode: isPrivate,
      localStream: o.localStream,
      sendSignal,
      onRemoteStream: (stream) => {
        setRemoteStream(stream);
        setRemoteAudioTrack(stream.getAudioTracks()[0] ?? null);
      },
      onConnectionStateChange: (state) => {
        setConnectionState(state);
        monitor.update(state);
        if (state === "connected") setConnectedAt((at) => at ?? Date.now());
      },
    });
    sessionRef.current = session;
    session.setVideoPaused(o.videoPaused, o.videoPlaceholder);
    setConnectionState(session.pc.connectionState);
    setQuality("GOOD");
    setFailure(null);
    setPrivateMode(isPrivate);
    setPrivateRequested(o.hideIp);
    setRelayed(false);
    setLowBandwidth(false);
    monitor.start();

    const unsubscribe = subscribeSignals(roomId, (signal) => void session.handleSignal(signal));
    void session.start();

    let previous: StatsSample | null = null;
    let lastStats: ConnectionStats | null = null;
    const loss = new LossTracker();
    /** Bitrate setting last applied successfully, so it is only re-applied on a change. */
    let applied: string | null = null;

    const applyLimits = async (isRelayedPath: boolean, low: boolean) => {
      const sender = session.video;
      if (!sender) return;
      const kbps = videoBitrateKbps(caps, isRelayedPath, low);
      const scale = low ? scaleDownFor(sender.track?.getSettings?.().height) : 1;
      const key = `${kbps}:${scale}`;
      if (applied === key) return;
      if (await applyVideoSenderLimits(sender, kbps, scale)) applied = key;
    };

    const statsTimer = setInterval(async () => {
      const state = session.pc.connectionState;
      if (state === "failed" || state === "disconnected" || state === "closed") {
        setQuality("DISCONNECTED");
        return;
      }
      if (state !== "connected") return;
      try {
        const report = await session.pc.getStats();
        const sample = readStats(report);
        setQuality(qualityFromStats(sample, previous));
        previous = sample;
        const stats = readConnectionStats(report);
        lastStats = stats;
        const isRelayedPath = isRelayed(stats);
        setRelayed(isRelayedPath);
        if (loss.push(stats)) setLowBandwidth(true);
        await applyLimits(isRelayedPath, loss.steppedDown);
      } catch {
        // The connection closed between the check and getStats.
      }
    }, STATS_INTERVAL_MS);

    return () => {
      clearInterval(statsTimer);
      monitor.stop();
      unsubscribe();
      latest.current.onTelemetry(
        buildTelemetry({
          roomId,
          outcome: monitor.outcome,
          timeToConnectMs: monitor.timeToConnectMs,
          connectedAt: monitor.connectedAt,
          endedAt: Date.now(),
          privateMode: isPrivate,
          stats: lastStats,
        }),
      );
      session.close();
      if (sessionRef.current === session) sessionRef.current = null;
      setRemoteStream(null);
      setRemoteAudioTrack(null);
      setConnectionState("idle");
      setFailure(null);
      setPrivateMode(false);
      setPrivateRequested(false);
      setRelayed(false);
      setLowBandwidth(false);
      setConnectedAt(null);
    };
  }, [roomId, initiator, sendSignal, subscribeSignals]);

  // The face gate pauses and resumes our video without renegotiating.
  useEffect(() => {
    sessionRef.current?.setVideoPaused(opts.videoPaused, opts.videoPlaceholder);
  }, [opts.videoPaused, opts.videoPlaceholder]);

  // A new camera or microphone (camera flip, recovery after backgrounding) replaces the sent tracks.
  useEffect(() => {
    sessionRef.current?.setLocalStream(opts.localStream);
  }, [opts.localStream]);

  return {
    remoteStream,
    remoteAudioTrack,
    connectionState,
    connectedAt,
    quality,
    failure,
    privateMode,
    privateRequested,
    relayed,
    lowBandwidth,
  };
}
