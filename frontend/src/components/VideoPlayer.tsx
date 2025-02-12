import React from "react";

interface VideoPlayerProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  muted?: boolean;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  videoRef,
  muted = false,
}) => {
  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted}
      className="w-full h-full object-cover"
    />
  );
};
