/**
 * The video the partner receives while the face gate has paused ours: the
 * last camera frame shrunk to a few pixels (unrecognisable colour blobs),
 * darkened, with a short notice. Redrawn a few times a second so the
 * receiver keeps getting frames.
 */
const WIDTH = 320;
const HEIGHT = 240;
const REDRAW_MS = 500;

export interface Placeholder {
  track: MediaStreamTrack;
  stop: () => void;
}

export function createPausedPlaceholder(source: HTMLVideoElement | null, text = "Video paused"): Placeholder | null {
  const canvas = document.createElement("canvas");
  if (typeof canvas.captureStream !== "function") return null;
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // 8x6 pixels of the last frame: colours only, no shapes.
  const tiny = document.createElement("canvas");
  tiny.width = 8;
  tiny.height = 6;
  const tinyCtx = tiny.getContext("2d");
  if (tinyCtx && source && source.videoWidth > 0) {
    try {
      tinyCtx.drawImage(source, 0, 0, tiny.width, tiny.height);
    } catch {
      // Draw the plain background instead.
    }
  }

  const draw = () => {
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.6;
    ctx.drawImage(tiny, 0, 0, WIDTH, HEIGHT);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 18px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, WIDTH / 2, HEIGHT / 2);
  };
  draw();
  const stream = canvas.captureStream(5);
  const [track] = stream.getVideoTracks();
  if (!track) return null;
  const timer = setInterval(draw, REDRAW_MS);
  return {
    track,
    stop: () => {
      clearInterval(timer);
      track.stop();
    },
  };
}
