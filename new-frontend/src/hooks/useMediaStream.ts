import { useState, useEffect, useRef } from 'react';

export const useMediaStream = () => {
  const [localAudioTrack, setLocalAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [localVideoTrack, setLocalVideoTrack] = useState<MediaStreamTrack | null>(null);
  const [hasPermission, setHasPermission] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const getCam = async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true
      });
      
      const audioTrack = mediaStream.getAudioTracks()[0];
      const videoTrack = mediaStream.getVideoTracks()[0];
      
      setLocalAudioTrack(audioTrack);
      setLocalVideoTrack(videoTrack);
      setStream(mediaStream);
      setHasPermission(true);
      
      console.log('Camera stream acquired successfully');
    } catch (error) {
      console.error('Error accessing media devices:', error);
      setError('Unable to access camera and microphone. Please check permissions.');
      setHasPermission(false);
    } finally {
      setIsLoading(false);
    }
  };

  const stopStream = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    if (localAudioTrack) {
      localAudioTrack.stop();
      setLocalAudioTrack(null);
    }
    if (localVideoTrack) {
      localVideoTrack.stop();
      setLocalVideoTrack(null);
    }
    setHasPermission(false);
  };

  const restartStream = () => {
    stopStream();
    getCam();
  };

  // Initialize camera once on mount
  useEffect(() => {
    getCam();
    
    return () => {
      // Cleanup on unmount
      stopStream();
    };
  }, []); // Empty dependency array to run only once

  // Update video element when stream changes
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(err => {
        console.log('Video play failed:', err);
        // Don't set this as an error, it's often just a timing issue
      });
    }
  }, [stream]);

  return {
    localAudioTrack,
    localVideoTrack,
    videoRef,
    hasPermission,
    isLoading,
    error,
    getCam,
    stopStream,
    restartStream,
    stream
  };
};