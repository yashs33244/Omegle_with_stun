import { useEffect, useState } from "react";
import { parseStunList, probeNetwork, type NetworkProbeResult } from "@/lib/connectivity";
import type { IceServer } from "@/lib/protocol";
import { averageBrightness, grabFrame } from "@/moderation/frames";

/** Below this average brightness (0 to 255) the camera image is too dark for the face check. */
export const DARK_THRESHOLD = 60;

/**
 * STUN servers for the pre-flight probe. TURN credentials only exist per call,
 * so before the first match the probe can test direct paths but not the relay.
 * VITE_PROBE_STUN_URLS overrides the default (empty turns STUN off).
 */
export const PROBE_ICE_SERVERS: IceServer[] = parseStunList(import.meta.env.VITE_PROBE_STUN_URLS ?? "stun:stun.cloudflare.com:3478");

export type NetworkCheck = { status: "checking" } | { status: "done"; result: NetworkProbeResult } | { status: "failed" };

export interface Preflight {
  /** Microphone level, 0 to 1. */
  micLevel: number;
  /** "dark" when the image is too dark to see a face well; null until measured. */
  lighting: "ok" | "dark" | null;
  network: NetworkCheck;
}

export function lightingFor(brightness: number): "ok" | "dark" {
  return brightness < DARK_THRESHOLD ? "dark" : "ok";
}

/** Pre-flight checks before the first match: mic level, lighting and a 2 s network probe. */
export function usePreflight(stream: MediaStream | null, iceServers: IceServer[] = PROBE_ICE_SERVERS): Preflight {
  const [micLevel, setMicLevel] = useState(0);
  const [lighting, setLighting] = useState<Preflight["lighting"]>(null);
  const [network, setNetwork] = useState<NetworkCheck>({ status: "checking" });

  // Network probe, once.
  useEffect(() => {
    if (typeof RTCPeerConnection === "undefined") {
      setNetwork({ status: "failed" });
      return;
    }
    let cancelled = false;
    probeNetwork(iceServers)
      .then((result) => !cancelled && setNetwork({ status: "done", result }))
      .catch(() => !cancelled && setNetwork({ status: "failed" }));
    return () => {
      cancelled = true;
    };
    // The probe runs once per page; later server lists do not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mic level meter.
  const audioTrack = stream?.getAudioTracks()[0] ?? null;
  useEffect(() => {
    const Ctor =
      window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!audioTrack || !Ctor || typeof MediaStream === "undefined") return;
    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(new MediaStream([audioTrack])).connect(analyser);
    void ctx.resume().catch(() => {});
    const data = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      setMicLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
    }, 100);
    return () => {
      clearInterval(timer);
      void ctx.close().catch(() => {});
    };
  }, [audioTrack]);

  // Lighting hint from the camera image, once a second.
  const videoTrack = stream?.getVideoTracks()[0] ?? null;
  useEffect(() => {
    if (!videoTrack || typeof MediaStream === "undefined") return;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([videoTrack]);
    void video.play().catch(() => {});
    const canvas = document.createElement("canvas");
    const timer = setInterval(() => {
      const frame = grabFrame(video, 32, "fit", canvas);
      if (frame) setLighting(lightingFor(averageBrightness(frame)));
    }, 1000);
    return () => {
      clearInterval(timer);
      video.srcObject = null;
    };
  }, [videoTrack]);

  return { micLevel, lighting, network };
}
