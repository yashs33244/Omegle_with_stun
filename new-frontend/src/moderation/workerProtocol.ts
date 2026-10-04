/** Messages between the page and the moderation workers. Frames never leave the device. */

export type WorkerRequest =
  | { type: "load" }
  /** The image's pixel buffer is transferred, not copied. */
  | { type: "run"; id: number; image: ImageData };

export type WorkerResponse<R> =
  | { type: "loaded"; ms: number; backend: string }
  | { type: "load-error"; message: string }
  | { type: "result"; id: number; result: R }
  | { type: "error"; id: number; message: string };

export interface FaceResult {
  faces: number;
}

export interface NsfwResult {
  scores: { Drawing: number; Hentai: number; Neutral: number; Porn: number; Sexy: number };
}
