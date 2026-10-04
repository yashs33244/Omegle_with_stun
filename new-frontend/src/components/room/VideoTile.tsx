import React, { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";

interface VideoTileProps {
  stream: MediaStream | null;
  /** Local preview only. The partner's video is never mirrored. */
  mirrored?: boolean;
  /** True for the local preview (no echo). Remote tiles play sound. */
  muted: boolean;
  testId: string;
  /** Keep the element (and its audio) alive but invisible. */
  hidden?: boolean;
  /** Shows a spinner with this text until the first frame arrives. */
  loadingLabel?: string;
  /** Safe-start blur: the partner's video is blurred until the on-device check passes. */
  blurred?: boolean;
  /** Gives the <video> to frame samplers (on-device moderation). */
  onVideoElement?: (video: HTMLVideoElement | null) => void;
}

/**
 * A <video> bound to a MediaStream. Browsers may refuse autoplay with sound;
 * then the tile plays muted and offers a "Tap to enable audio" button.
 */
export const VideoTile: React.FC<VideoTileProps> = ({
  stream,
  mirrored = false,
  muted,
  testId,
  hidden = false,
  loadingLabel,
  blurred = false,
  onVideoElement,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    onVideoElement?.(videoRef.current);
    return () => onVideoElement?.(null);
  }, [onVideoElement]);

  // iOS Safari can leave a video frozen after the page was in the background:
  // re-attach the stream and play again when the page is visible.
  useEffect(() => {
    const onVisible = () => {
      const video = videoRef.current;
      if (document.visibilityState !== "visible" || !video || !stream) return;
      if (video.srcObject !== stream) video.srcObject = stream;
      if (video.paused) {
        video.play().catch(() => {
          // The autoplay fallback below already offers "Tap to enable audio".
        });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setLoaded(false);
    setAudioBlocked(false);
    video.srcObject = stream;
    if (!stream) return;
    // React does not reliably reflect the muted prop to the DOM property.
    video.muted = muted;
    let cancelled = false;
    video.play().catch((err: unknown) => {
      if (cancelled || muted) return;
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setAudioBlocked(true);
        video.muted = true;
        video.play().catch(() => {
          // Even muted playback refused; the overlay button retries with a user gesture.
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [stream, muted]);

  const enableAudio = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    video
      .play()
      .then(() => setAudioBlocked(false))
      .catch(() => {
        video.muted = true;
      });
  };

  return (
    <>
      <video
        ref={videoRef}
        data-testid={testId}
        autoPlay
        playsInline
        muted={muted}
        onLoadedData={() => setLoaded(true)}
        data-blurred={blurred ? "true" : "false"}
        className={`w-full h-full object-cover ${hidden ? "hidden" : ""}`}
        style={{
          transform: mirrored ? "scaleX(-1)" : undefined,
          filter: blurred
            ? "blur(24px)"
            : mirrored
              ? undefined
              : "brightness(1.1) contrast(1.1) saturate(1.1)",
          zIndex: 3,
          position: "relative",
        }}
      />
      {!hidden && loadingLabel && !loaded && (
        <div className="video-loading-overlay">
          <div className="text-center text-white space-y-4">
            <div className="loading-spinner mx-auto"></div>
            <p className="text-lg font-medium">{loadingLabel}</p>
          </div>
        </div>
      )}
      {!hidden && audioBlocked && (
        <div className="absolute inset-x-0 bottom-16 flex justify-center" style={{ zIndex: 25 }}>
          <button type="button" onClick={enableAudio} className="retro-button flex items-center gap-2">
            <Volume2 className="w-5 h-5" />
            Tap to enable audio
          </button>
        </div>
      )}
    </>
  );
};
