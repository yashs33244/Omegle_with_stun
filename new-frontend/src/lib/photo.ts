import { LIMITS, profileSchema } from "./protocol";

/** Profile photos are avatars: a small square is plenty and keeps every match payload light. */
export const PHOTO_MAX_SIDE = 256;
export const PHOTO_QUALITY = 0.8;

export type PhotoErrorReason = "not-ready" | "encode-failed" | "too-large";

export class PhotoCaptureError extends Error {
  readonly reason: PhotoErrorReason;

  constructor(reason: PhotoErrorReason, message: string) {
    super(message);
    this.name = "PhotoCaptureError";
    this.reason = reason;
  }
}

export interface CropBox {
  /** Source rectangle (a centered square of the frame). */
  sx: number;
  sy: number;
  sSize: number;
  /** Output side length, never larger than the source and at most maxSide. */
  size: number;
}

/** Centered square crop of a width x height frame, scaled down to at most maxSide. */
export function squareCrop(width: number, height: number, maxSide = PHOTO_MAX_SIDE): CropBox {
  const sSize = Math.min(width, height);
  return {
    sx: Math.floor((width - sSize) / 2),
    sy: Math.floor((height - sSize) / 2),
    sSize,
    size: Math.min(sSize, maxSide),
  };
}

/** True when the server would accept this string as a profile photo. */
export function isAcceptablePhoto(dataUrl: string): boolean {
  return profileSchema.shape.photo.safeParse(dataUrl).success;
}

type FrameSource = Pick<HTMLVideoElement, "videoWidth" | "videoHeight"> & CanvasImageSource;

/**
 * Grabs the current video frame as a small JPEG data URL that fits the
 * protocol limits. The image keeps its true orientation (not mirrored like
 * the self-preview), so text in the photo reads correctly for the partner.
 *
 * Throws PhotoCaptureError when the camera has no frame yet, the browser
 * cannot encode JPEG, or the result is over LIMITS.photoMaxChars.
 */
export function captureVideoFrame(
  video: FrameSource,
  canvas: HTMLCanvasElement = document.createElement("canvas"),
): string {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) {
    throw new PhotoCaptureError("not-ready", "The camera is not showing a picture yet. Wait a moment and try again.");
  }

  const crop = squareCrop(videoWidth, videoHeight);
  canvas.width = crop.size;
  canvas.height = crop.size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new PhotoCaptureError("encode-failed", "This browser could not create the photo.");
  }
  ctx.drawImage(video, crop.sx, crop.sy, crop.sSize, crop.sSize, 0, 0, crop.size, crop.size);

  const dataUrl = canvas.toDataURL("image/jpeg", PHOTO_QUALITY);
  if (!dataUrl.startsWith("data:image/jpeg;base64,")) {
    throw new PhotoCaptureError("encode-failed", "This browser could not create the photo.");
  }
  if (dataUrl.length > LIMITS.photoMaxChars) {
    throw new PhotoCaptureError("too-large", "The photo came out too large. Try again in different lighting.");
  }
  return dataUrl;
}
