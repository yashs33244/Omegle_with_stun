import { useCallback, useEffect, useRef, useState } from "react";
import { BlurMonitor, type BlurSignal, type BlurStatus, type NsfwScores } from "./blurGate";
import { grabFrame } from "./frames";
import { nsfwModel } from "./modelClient";
import { moderationOverrides } from "./testHooks";

const CLASSIFIER_SIZE = 224;
const NEUTRAL: NsfwScores = { Drawing: 0, Hentai: 0, Neutral: 1, Porn: 0, Sexy: 0 };

/** Classifies one frame or photo with the shared NSFW model (or the e2e bypass). */
export async function classifyImage(image: ImageData): Promise<NsfwScores> {
  if (moderationOverrides().nsfw === "pass") return NEUTRAL;
  return (await nsfwModel().run(image)).scores;
}

export interface RemoteBlurOptions {
  /** The current call; the gate restarts (blurred) for every new room. */
  roomId: string | null;
  /** The partner's <video>. */
  video: HTMLVideoElement | null;
  onSignal: (kind: BlurSignal) => void;
}

/** Safe-start blur for the partner's video. See blurGate.ts for the rules. */
export function useRemoteBlur({ roomId, video, onSignal }: RemoteBlurOptions): { status: BlurStatus; reveal: () => void } {
  const [status, setStatus] = useState<BlurStatus>("checking");
  const videoRef = useRef(video);
  videoRef.current = video;
  const onSignalRef = useRef(onSignal);
  onSignalRef.current = onSignal;
  const monitorRef = useRef<BlurMonitor | null>(null);

  useEffect(() => {
    setStatus("checking");
    if (!roomId) return;
    const canvas = document.createElement("canvas");
    const monitor = new BlurMonitor({
      grab: () => grabFrame(videoRef.current, CLASSIFIER_SIZE, "square", canvas),
      classify: (image) => classifyImage(image),
      onChange: (state) => setStatus(state.status),
      onSignal: (kind) => onSignalRef.current(kind),
    });
    monitorRef.current = monitor;
    monitor.start();
    return () => {
      monitor.stop();
      if (monitorRef.current === monitor) monitorRef.current = null;
    };
  }, [roomId]);

  const reveal = useCallback(() => monitorRef.current?.reveal(), []);
  return { status, reveal };
}
