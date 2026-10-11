/**
 * Sender-side face gate. The local camera is checked about twice a second;
 * when no face has been seen for NO_FACE_PAUSE_MS, the outgoing video is
 * swapped for a blurred placeholder until a face is back. Each pause is one
 * "episode" and is reported to the server once (a count, never a frame).
 */
import { browserTimers, type Timers } from "@/lib/connectivity";

export const FACE_SAMPLE_MS = 500;
export const NO_FACE_PAUSE_MS = 3000;

export interface FaceGateState {
  /** The detector is loaded and running. False means fail open: video is never paused. */
  running: boolean;
  paused: boolean;
  /** Last time a face was seen (or the gate started, as a grace period). */
  lastFaceAt: number;
  /** Number of pause episodes so far. */
  episodes: number;
}

export type FaceGateEvent =
  | { type: "start"; at: number }
  | { type: "detection"; face: boolean; at: number }
  | { type: "unavailable" }
  | { type: "stop" };

export const initialFaceGateState: FaceGateState = { running: false, paused: false, lastFaceAt: 0, episodes: 0 };

export function faceGateReducer(state: FaceGateState, event: FaceGateEvent): FaceGateState {
  switch (event.type) {
    case "start":
      return { ...state, running: true, paused: false, lastFaceAt: event.at };
    case "detection":
      if (!state.running) return state;
      if (event.face) return { ...state, paused: false, lastFaceAt: event.at };
      if (state.paused || event.at - state.lastFaceAt < NO_FACE_PAUSE_MS) return state;
      return { ...state, paused: true, episodes: state.episodes + 1 };
    case "unavailable":
    case "stop":
      // Never hold the video hostage to a model that cannot run.
      return { ...state, running: false, paused: false };
  }
}

export interface FaceGateDeps {
  /** Prepares the detector; a rejection means the gate fails open. */
  load: () => Promise<void>;
  /** A small frame of the local camera, or null when there is none yet. */
  grab: () => ImageData | null;
  /** True when at least one face is in the frame. */
  detect: (image: ImageData) => Promise<boolean>;
  onPausedChange: (paused: boolean, episodes: number) => void;
  /** The detector could not load or run; the gate is off until restarted. */
  onUnavailable?: () => void;
  timers?: Timers;
}

/** Runs the face gate: about two checks a second while started. */
export class FaceGateMonitor {
  private readonly deps: FaceGateDeps;
  private readonly timers: Timers;
  private _state: FaceGateState = initialFaceGateState;
  private timer: unknown = null;
  private stopped = false;

  constructor(deps: FaceGateDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? browserTimers;
  }

  get state(): FaceGateState {
    return this._state;
  }

  async start(): Promise<void> {
    try {
      await this.deps.load();
    } catch {
      this.fail();
      return;
    }
    if (this.stopped) return;
    this.apply({ type: "start", at: this.timers.now() });
    this.schedule(0);
  }

  stop(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (!this.stopped) this.apply({ type: "stop" });
    this.stopped = true;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const at = this.timers.now();
    const image = this.deps.grab();
    if (image) {
      try {
        const face = await this.deps.detect(image);
        if (this.stopped) return;
        this.apply({ type: "detection", face, at });
      } catch {
        this.fail();
        return;
      }
    }
    this.schedule(FACE_SAMPLE_MS);
  }

  private fail(): void {
    if (this.stopped) return;
    this.apply({ type: "unavailable" });
    this.stopped = true;
    this.deps.onUnavailable?.();
  }

  private apply(event: FaceGateEvent): void {
    const previous = this._state;
    this._state = faceGateReducer(previous, event);
    if (this._state.paused !== previous.paused) this.deps.onPausedChange(this._state.paused, this._state.episodes);
  }
}
