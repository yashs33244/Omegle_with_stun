import { useState, useEffect, useRef } from 'react';

export const useMediaStream = () => {
  const [localAudioTrack, setLocalAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [localVideoTrack, setLocalVideoTrack] = useState<MediaStreamTrack | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const getCam = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      
      const audioTrack = stream.getAudioTracks()[0];
      const videoTrack = stream.getVideoTracks()[0];
      
      setLocalAudioTrack(audioTrack);
      setLocalVideoTrack(videoTrack);
      
      if (videoRef.current) {
        videoRef.current.srcObject = new MediaStream([videoTrack]);
        videoRef.current.play().catch(console.error);
      }
    } catch (error) {
      console.error('Error accessing media devices:', error);
    }
  };

  useEffect(() => {
    if (videoRef.current) {
      getCam();
    }
  }, [videoRef]);

  return {
    localAudioTrack,
    localVideoTrack,
    videoRef
  };
};