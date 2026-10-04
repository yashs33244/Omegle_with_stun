/** Camera labels of common virtual cameras (screen or file feeds instead of a person). */
const VIRTUAL_CAMERA = /OBS|ManyCam|Virtual|XSplit|Snap Camera|CamTwist/i;

export function isVirtualCameraLabel(label: string | undefined | null): boolean {
  return !!label && VIRTUAL_CAMERA.test(label);
}

/**
 * Label of the camera behind a video track: the track label, or the matching
 * MediaDeviceInfo label when the track has none.
 */
export async function activeCameraLabel(track: MediaStreamTrack | null | undefined): Promise<string> {
  if (!track) return "";
  if (track.label) return track.label;
  const deviceId = track.getSettings?.().deviceId;
  if (!deviceId || !navigator.mediaDevices?.enumerateDevices) return "";
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.find((d) => d.kind === "videoinput" && d.deviceId === deviceId)?.label ?? "";
  } catch {
    return "";
  }
}
