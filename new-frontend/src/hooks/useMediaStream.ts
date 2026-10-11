import { useState, useEffect, useRef, useCallback } from 'react';
import { runningOnMobile } from '@/lib/mobile';

/** Copy lives in `room:camera.<kind>.title` / `.message`. */
export type MediaAccessErrorKind = 'denied' | 'not-found' | 'in-use' | 'unsupported' | 'unknown';

export interface MediaAccessError {
  kind: MediaAccessErrorKind;
}

function errorName(err: unknown): string {
  return err instanceof DOMException || err instanceof Error ? err.name : '';
}

/** Maps a getUserMedia failure to its real cause instead of always blaming permissions. */
export function describeMediaError(err: unknown): MediaAccessError {
  let kind: MediaAccessErrorKind;
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
  return { kind };
}

export type FacingMode = 'user' | 'environment';

/** Phones capture 640x480 at 24 fps (encoder and battery budget); desktops ask for 720p. */
export function videoConstraints(mobile: boolean, facingMode: FacingMode = 'user'): MediaTrackConstraints {
  return mobile
    ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 }, facingMode }
    : { width: { ideal: 1280 }, height: { ideal: 720 } };
}

async function openCamera(facingMode: FacingMode = 'user'): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException('mediaDevices is not available', 'MediaDevicesUnavailable');
  }
  const video = videoConstraints(runningOnMobile(), facingMode);
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: true });
  } catch (err) {
    // A camera without a microphone still works for video chat; retry without audio.
    if (errorName(err) !== 'NotFoundError') throw err;
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch {
      throw err;
    }
  }
}

/** Tracks that need a fresh getUserMedia after the page comes back (iOS ends or mutes them in the background). */
export function needsReacquire(stream: MediaStream | null): boolean {
  if (!stream) return false;
  return stream.getTracks().some((t) => t.readyState === 'ended' || (t.kind === 'video' && t.muted));
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
  const [facingMode, setFacingMode] = useState<FacingMode>('user');
  const facingRef = useRef<FacingMode>('user');
  const enabledRef = useRef({ mic: true, camera: true });
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
      const mediaStream = await openCamera(facingRef.current);
      if (request !== requestRef.current || !mountedRef.current) {
        mediaStream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = mediaStream;
      setStream(mediaStream);
      enabledRef.current = { mic: true, camera: true };
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
    enabledRef.current.mic = enabled;
    setMicEnabledState(enabled);
  }, []);

  const setCameraEnabled = useCallback((enabled: boolean) => {
    streamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = enabled;
    });
    enabledRef.current.camera = enabled;
    setCameraEnabledState(enabled);
  }, []);

  /**
   * Swaps in fresh tracks without a loading state, keeping mute and camera-off.
   * A new MediaStream object, so the peer connection replaces its sent tracks.
   */
  const reacquire = useCallback(async (facing: FacingMode, videoOnly: boolean): Promise<boolean> => {
    const current = streamRef.current;
    if (!current || !navigator.mediaDevices?.getUserMedia) return false;
    const request = requestRef.current;
    const video = videoConstraints(runningOnMobile(), facing);
    // Phones often cannot open a second camera while the first is open.
    if (videoOnly) current.getVideoTracks().forEach((t) => t.stop());
    let fresh: MediaStream;
    try {
      fresh = await navigator.mediaDevices.getUserMedia({ video, audio: !videoOnly && current.getAudioTracks().length > 0 });
    } catch (err) {
      console.warn('Could not reopen the camera', err);
      return false;
    }
    if (request !== requestRef.current || !mountedRef.current || streamRef.current !== current) {
      fresh.getTracks().forEach((t) => t.stop());
      return false;
    }
    const audio = videoOnly ? current.getAudioTracks() : fresh.getAudioTracks();
    if (!videoOnly) current.getTracks().forEach((t) => t.stop());
    audio.forEach((t) => (t.enabled = enabledRef.current.mic));
    fresh.getVideoTracks().forEach((t) => (t.enabled = enabledRef.current.camera));
    const next = new MediaStream([...audio, ...fresh.getVideoTracks()]);
    streamRef.current = next;
    setStream(next);
    return true;
  }, []);

  /** Front/back camera toggle (phones). */
  const flipCamera = useCallback(async () => {
    const next: FacingMode = facingRef.current === 'user' ? 'environment' : 'user';
    if (await reacquire(next, true)) {
      facingRef.current = next;
      setFacingMode(next);
    } else {
      // Put the previous camera back if the other one could not open.
      await reacquire(facingRef.current, true);
    }
  }, [reacquire]);

  // iOS Safari ends or mutes camera tracks while the page is in the background.
  // When the page comes back, reopen them; the call then swaps the tracks in.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (timer) clearTimeout(timer);
      // Give a briefly muted track a moment to come back on its own.
      timer = setTimeout(() => {
        if (needsReacquire(streamRef.current)) void reacquire(facingRef.current, false);
      }, 500);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (timer) clearTimeout(timer);
    };
  }, [reacquire]);

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
    facingMode,
    flipCamera,
  };
};
