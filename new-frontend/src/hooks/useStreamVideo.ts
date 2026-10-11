import { useEffect, useState } from "react";

/**
 * Callback ref that binds a MediaStream to whichever <video> is mounted right
 * now. A remounted element (back from a chat, Retake Photo) is rebound too.
 */
export function useStreamVideo(stream: MediaStream | null) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    if (stream) {
      video.play().catch(() => {
        // Muted preview; a rejected play only means the element was replaced again.
      });
    }
  }, [video, stream]);
  return [setVideo, video] as const;
}
