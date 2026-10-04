/** Small frames for the on-device models. Pixels stay on this device. */

type Drawable = HTMLVideoElement | HTMLImageElement;

function sourceSize(source: Drawable): { width: number; height: number } {
  return source instanceof HTMLVideoElement
    ? { width: source.videoWidth, height: source.videoHeight }
    : { width: source.naturalWidth, height: source.naturalHeight };
}

/** True when the video has a decoded frame to sample. */
export function hasFrame(video: HTMLVideoElement | null): video is HTMLVideoElement {
  return !!video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
}

export type CropMode = "square" | "fit";

/**
 * Draws the source into a canvas of the given width and returns its pixels.
 * "square" takes the centre square (for the 224 px classifier); "fit" keeps
 * the aspect ratio (for the face detector). Returns null when nothing is drawable.
 */
export function grabFrame(source: Drawable | null, width: number, mode: CropMode, canvas?: HTMLCanvasElement): ImageData | null {
  if (!source) return null;
  if (source instanceof HTMLVideoElement && !hasFrame(source)) return null;
  const { width: sw, height: sh } = sourceSize(source);
  if (!sw || !sh) return null;
  const c = canvas ?? document.createElement("canvas");
  let sx = 0;
  let sy = 0;
  let cw = sw;
  let ch = sh;
  let height: number;
  if (mode === "square") {
    const side = Math.min(sw, sh);
    sx = (sw - side) / 2;
    sy = (sh - side) / 2;
    cw = ch = side;
    height = width;
  } else {
    height = Math.max(1, Math.round((width * sh) / sw));
  }
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(source, sx, sy, cw, ch, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } catch {
    // A tainted or not-yet-decoded source.
    return null;
  }
}

/** Decodes an inline image (a profile photo data URL). */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to decode"));
    img.src = src;
  });
}

/** Average brightness (0 to 255) of an image, for the lighting hint. */
export function averageBrightness(image: ImageData): number {
  const d = image.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
  return d.length ? sum / (d.length / 4) : 0;
}
