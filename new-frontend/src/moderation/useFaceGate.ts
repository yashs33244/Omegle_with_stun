import { useEffect, useRef, useState } from "react";
import i18n from "@/lib/i18n";
import { FaceGateMonitor } from "./faceGate";
import { grabFrame } from "./frames";
import { faceModel } from "./modelClient";
import { createPausedPlaceholder, type Placeholder } from "./placeholder";
import { moderationOverrides } from "./testHooks";

const DETECTOR_WIDTH = 320;

export interface FaceGateOptions {
  /** The local camera stream. */
  stream: MediaStream | null;
  /** Off in text-only mode and when the camera is off: nothing to gate then. */
  enabled: boolean;
  /** The current call, so each pause is reported once per call. */
  roomId: string | null;
  onNoFace: (roomId: string) => void;
}

export interface FaceGate {
  /** No face for 3 s: the partner gets the placeholder instead of the camera. */
  paused: boolean;
  /** What to send instead of the camera while paused (null: send nothing). */
  placeholder: MediaStreamTrack | null;
}

/** Sender face gate. See faceGate.ts for the rules. */
export function useFaceGate({ stream, enabled, roomId, onNoFace }: FaceGateOptions): FaceGate {
  const [paused, setPaused] = useState(false);
  const [episode, setEpisode] = useState(0);
  const [placeholder, setPlaceholder] = useState<Placeholder | null>(null);
  const onNoFaceRef = useRef(onNoFace);
  onNoFaceRef.current = onNoFace;
  const videoTrack = stream?.getVideoTracks()[0] ?? null;
  const active = enabled && !!videoTrack && moderationOverrides().faceGate === "real";

  useEffect(() => {
    if (!active || !videoTrack || typeof MediaStream === "undefined") return;
    // A private, muted element just for sampling, so layout changes never stop the gate.
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([videoTrack]);
    void video.play().catch(() => {
      // Muted autoplay can still be refused; sampling just finds no frame then.
    });
    const canvas = document.createElement("canvas");
    let current: Placeholder | null = null;
    const monitor = new FaceGateMonitor({
      load: () => faceModel().load(),
      grab: () => grabFrame(video, DETECTOR_WIDTH, "fit", canvas),
      detect: async (image) => (await faceModel().run(image)).faces > 0,
      onPausedChange: (nowPaused, episodes) => {
        current?.stop();
        current = nowPaused ? createPausedPlaceholder(video, i18n.t("room:faceGate.placeholder")) : null;
        setPlaceholder(current);
        setPaused(nowPaused);
        setEpisode(episodes);
      },
    });
    void monitor.start();
    return () => {
      monitor.stop();
      current?.stop();
      video.srcObject = null;
      setPlaceholder(null);
      setPaused(false);
    };
  }, [active, videoTrack]);

  // One "no-face" signal per pause episode and call.
  const reported = useRef(new Set<string>());
  useEffect(() => {
    if (!paused || !roomId) return;
    const key = `${episode}:${roomId}`;
    if (reported.current.has(key)) return;
    reported.current.add(key);
    onNoFaceRef.current(roomId);
  }, [paused, episode, roomId]);

  return { paused, placeholder: placeholder?.track ?? null };
}
