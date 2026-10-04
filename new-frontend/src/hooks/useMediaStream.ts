import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Owns the camera and microphone. The live stream is kept in a ref so cleanup
 * always stops the current tracks (state captured by an old closure would be
 * stale). Mute and camera-off flip track.enabled, so the peer connection keeps
 * its senders and the partner simply receives silence or black frames.
 */
/** A message that matches the actual cause instead of always blaming permissions. */
export function mediaErrorMessage(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera and microphone access was blocked. Allow it in your browser settings and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera or microphone was found. Connect one and try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Your camera or microphone is being used by another app. Close it and try again.';
    case 'MediaDevicesUnavailable':
      return 'This browser cannot access a camera here. Use a recent browser over https.';
    default:
      return 'Unable to access camera and microphone. Please check permissions.';
  }
}

export const useMediaStream = () => {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [hasPermission, setHasPermission] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [micEnabled, setMicEnabledState] = useState<boolean>(true);
  const [cameraEnabled, setCameraEnabledState] = useState<boolean>(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef<boolean>(true);
  // Bumped on every start/stop so a slow getUserMedia from an older call is discarded.
  const requestRef = useRef<number>(0);

  const stopStream = useCallback(() => {
    requestRef.current += 1;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (!mountedRef.current) return;
    setStream(null);
    setHasPermission(false);
    setIsLoading(false);
  }, []);

  const getCam = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    setIsLoading(true);
    setError(null);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DOMException('mediaDevices is not available', 'MediaDevicesUnavailable');
      }
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
      if (request !== requestRef.current || !mountedRef.current) {
        mediaStream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = mediaStream;
      setStream(mediaStream);
      setHasPermission(true);
      setMicEnabledState(true);
      setCameraEnabledState(true);
    } catch (err) {
      if (request !== requestRef.current || !mountedRef.current) return;
      console.error('Error accessing media devices:', err);
      setError(mediaErrorMessage(err));
      setHasPermission(false);
    } finally {
      if (request === requestRef.current && mountedRef.current) setIsLoading(false);
    }
  }, []);

  const restartStream = useCallback(() => {
    stopStream();
    void getCam();
  }, [stopStream, getCam]);

  const setMicEnabled = useCallback((enabled: boolean) => {
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
    setMicEnabledState(enabled);
  }, []);

  const setCameraEnabled = useCallback((enabled: boolean) => {
    streamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = enabled;
    });
    setCameraEnabledState(enabled);
  }, []);

  // Acquire the camera once on mount; stop every track on unmount.
  useEffect(() => {
    mountedRef.current = true;
    void getCam();
    return () => {
      mountedRef.current = false;
      stopStream();
    };
  }, [getCam, stopStream]);

  // Update the preview element when the stream changes.
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(() => {
        // Autoplay of a muted preview can still be interrupted by a re-render; harmless.
      });
    }
  }, [stream]);

  return {
    localAudioTrack: stream?.getAudioTracks()[0] ?? null,
    localVideoTrack: stream?.getVideoTracks()[0] ?? null,
    videoRef,
    hasPermission,
    isLoading,
    error,
    getCam,
    stopStream,
    restartStream,
    stream,
    micEnabled,
    cameraEnabled,
    setMicEnabled,
    setCameraEnabled,
  };
};
