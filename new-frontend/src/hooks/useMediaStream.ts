import { useState, useEffect, useRef, useCallback } from 'react';

export type MediaErrorKind = 'denied' | 'not-found' | 'in-use' | 'unsupported' | 'unknown';

export interface MediaAccessError {
  kind: MediaErrorKind;
  title: string;
  message: string;
}

const MEDIA_ERRORS: Record<MediaErrorKind, Omit<MediaAccessError, 'kind'>> = {
  denied: {
    title: 'Camera access is blocked',
    message: 'Allow camera and microphone access for this site in your browser settings, then try again.',
  },
  'not-found': {
    title: 'No camera found',
    message: 'Connect a camera and try again.',
  },
  'in-use': {
    title: 'Camera is busy',
    message: 'Another app or tab is using your camera. Close it and try again.',
  },
  unsupported: {
    title: 'Camera not available',
    message: 'This browser cannot use a camera on this page. Use a recent browser over https.',
  },
  unknown: {
    title: 'Could not start the camera',
    message: 'Check that your camera works and that this site may use it, then try again.',
  },
};

function errorName(err: unknown): string {
  return err instanceof DOMException || err instanceof Error ? err.name : '';
}

/** Maps a getUserMedia failure to its real cause instead of always blaming permissions. */
export function describeMediaError(err: unknown): MediaAccessError {
  let kind: MediaErrorKind;
  switch (errorName(err)) {
    case 'NotAllowedError':
    case 'SecurityError':
      kind = 'denied';
      break;
    case 'NotFoundError':
    case 'OverconstrainedError':
      kind = 'not-found';
      break;
    case 'NotReadableError':
    case 'AbortError':
      kind = 'in-use';
      break;
    case 'MediaDevicesUnavailable':
      kind = 'unsupported';
      break;
    default:
      kind = 'unknown';
  }
  return { kind, ...MEDIA_ERRORS[kind] };
}

const VIDEO_CONSTRAINTS: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };

async function openCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException('mediaDevices is not available', 'MediaDevicesUnavailable');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: true });
  } catch (err) {
    // A camera without a microphone still works for video chat; retry without audio.
    if (errorName(err) !== 'NotFoundError') throw err;
    try {
      return await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: false });
    } catch {
      throw err;
    }
  }
}

/**
 * Owns the camera and microphone. The live stream is kept in a ref so cleanup
 * always stops the current tracks (state captured by an old closure would be
 * stale). Mute and camera-off flip track.enabled, so the peer connection keeps
 * its senders and the partner simply receives silence or black frames.
 *
 * The camera is requested once on mount. Callers retry with getCam() (a user
 * action), never from an effect, so a failure cannot turn into a retry loop.
 */
export const useMediaStream = () => {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<MediaAccessError | null>(null);
  const [micEnabled, setMicEnabledState] = useState<boolean>(true);
  const [cameraEnabled, setCameraEnabledState] = useState<boolean>(true);
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
    setIsLoading(false);
  }, []);

  const getCam = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const mediaStream = await openCamera();
      if (request !== requestRef.current || !mountedRef.current) {
        mediaStream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = mediaStream;
      setStream(mediaStream);
      setMicEnabledState(true);
      setCameraEnabledState(true);
    } catch (err) {
      if (request !== requestRef.current || !mountedRef.current) return;
      console.error('Error accessing media devices:', err);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStream(null);
      setError(describeMediaError(err));
    } finally {
      if (request === requestRef.current && mountedRef.current) setIsLoading(false);
    }
  }, []);

  /** Stops the current tracks and asks for a fresh camera stream. */
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

  return {
    stream,
    hasPermission: stream !== null,
    isLoading,
    error,
    getCam,
    stopStream,
    restartStream,
    micEnabled,
    cameraEnabled,
    setMicEnabled,
    setCameraEnabled,
  };
};
