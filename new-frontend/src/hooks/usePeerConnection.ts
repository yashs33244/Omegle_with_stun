import { useEffect, useRef, useState } from "react";
import type { IceServer, RtcSignal } from "@/lib/protocol";
import {
  PeerSession,
  qualityFromStats,
  readStats,
  type ConnectionQuality,
  type StatsSample,
} from "@/lib/peerSession";
import type { SignalListener } from "./useSignaling";

const STATS_INTERVAL_MS = 2000;

export interface PeerConnectionOptions {
  /** The current room while in a call, otherwise null. */
  roomId: string | null;
  /** From call:start; null until then. */
  initiator: boolean | null;
  iceServers: IceServer[];
  localStream: MediaStream | null;
  sendSignal: (signal: RtcSignal) => void;
  subscribeSignals: (roomId: string, listener: SignalListener) => () => void;
}

export interface PeerConnectionState {
  remoteStream: MediaStream | null;
  /** First audio track of the remote stream, for the speaking indicator. */
  remoteAudioTrack: MediaStreamTrack | null;
  connectionState: RTCPeerConnectionState | "idle";
  /** Local time the connection first reached "connected" in this call; null until then. */
  connectedAt: number | null;
  quality: ConnectionQuality;
}

/**
 * Exactly one RTCPeerConnection per call: created when a room has an
 * initiator (call:start), closed when the room ends, a new call starts,
 * or the component unmounts.
 */
export function usePeerConnection(opts: PeerConnectionOptions): PeerConnectionState {
  const { roomId, initiator, sendSignal, subscribeSignals } = opts;
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  // ontrack reuses one MediaStream per call; this re-renders when tracks are added to it.
  const [remoteAudioTrack, setRemoteAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [connectionState, setConnectionState] = useState<PeerConnectionState["connectionState"]>("idle");
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [quality, setQuality] = useState<ConnectionQuality>("GOOD");

  // Read when the call starts; changing them mid-call does not rebuild the connection.
  const iceServersRef = useRef(opts.iceServers);
  iceServersRef.current = opts.iceServers;
  const localStreamRef = useRef(opts.localStream);
  localStreamRef.current = opts.localStream;

  useEffect(() => {
    if (!roomId || initiator === null) return;

    const session = new PeerSession({
      roomId,
      initiator,
      iceServers: iceServersRef.current,
      localStream: localStreamRef.current,
      sendSignal,
      onRemoteStream: (stream) => {
        setRemoteStream(stream);
        setRemoteAudioTrack(stream.getAudioTracks()[0] ?? null);
      },
      onConnectionStateChange: (state) => {
        setConnectionState(state);
        if (state === "connected") setConnectedAt((at) => at ?? Date.now());
      },
    });
    setConnectionState(session.pc.connectionState);
    setQuality("GOOD");

    const unsubscribe = subscribeSignals(roomId, (signal) => void session.handleSignal(signal));
    void session.start();

    let previous: StatsSample | null = null;
    const statsTimer = setInterval(async () => {
      const state = session.pc.connectionState;
      if (state === "failed" || state === "disconnected" || state === "closed") {
        setQuality("DISCONNECTED");
        return;
      }
      if (state !== "connected") return;
      try {
        const sample = readStats(await session.pc.getStats());
        setQuality(qualityFromStats(sample, previous));
        previous = sample;
      } catch {
        // The connection closed between the check and getStats.
      }
    }, STATS_INTERVAL_MS);

    return () => {
      clearInterval(statsTimer);
      unsubscribe();
      session.close();
      setRemoteStream(null);
      setRemoteAudioTrack(null);
      setConnectionState("idle");
      setConnectedAt(null);
    };
  }, [roomId, initiator, sendSignal, subscribeSignals]);

  return { remoteStream, remoteAudioTrack, connectionState, connectedAt, quality };
}
