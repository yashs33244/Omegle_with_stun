/**
 * Receiver-side safe-start blur for the partner's video (and profile photo).
 *
 * The partner's video starts blurred. It is shown only after SAFE_STREAK
 * consecutive frames pass the on-device classifier, never on one frame and
 * never after a timer. A flagged frame hides the video for the rest of the
 * call. When the model cannot load or run, the video stays blurred and the
 * viewer may choose to show it ("Tap to show video").
 */
import { browserTimers, type Timers } from "@/lib/connectivity";

export const SAFE_STREAK = 3;
/** Sample every 500 ms for the first 10 s of a call, then every 2 s. */
export const FAST_SAMPLE_MS = 500;
export const SLOW_SAMPLE_MS = 2000;
export const FAST_PHASE_MS = 10_000;
/** Without a verdict this long after the first frame (model still loading or too slow), offer "Tap to show video". */
export const VERDICT_DEADLINE_MS = 10_000;
/** Poll interval while the partner's video has no frame yet. */
export const WAIT_FOR_FRAME_MS = 250;

export type BlurStatus =
  | "checking" // blurred, waiting for safe frames
  | "safe" // shown: the classifier passed SAFE_STREAK frames in a row
  | "flagged" // hidden for the rest of the call: "Video hidden. Report / Next"
  | "unavailable" // blurred: the model cannot run here; the viewer may tap to show
  | "revealed"; // shown because the viewer chose to, after the model failed

export interface BlurState {
  status: BlurStatus;
  safeStreak: number;
}

export type BlurEvent =
  | { type: "frame"; unsafe: boolean }
  | { type: "model-unavailable" }
  /** No verdict in time after the first frame arrived. */
  | { type: "deadline" }
  | { type: "reveal" }
  | { type: "reset" };

export const initialBlurState: BlurState = { status: "checking", safeStreak: 0 };

export function blurReducer(state: BlurState, event: BlurEvent): BlurState {
  switch (event.type) {
    case "reset":
      return initialBlurState;

    case "frame": {
      if (state.status === "flagged") return state;
      if (event.unsafe) return { status: "flagged", safeStreak: 0 };
      const safeStreak = state.safeStreak + 1;
      if (safeStreak >= SAFE_STREAK) return { status: "safe", safeStreak };
      return { ...state, safeStreak };
    }

    case "model-unavailable":
      // A shown video goes back behind the blur: without the model nothing would catch a flash.
      if (state.status === "checking" || state.status === "safe") return { status: "unavailable", safeStreak: 0 };
      return state;

    case "deadline":
      return state.status === "checking" ? { ...state, status: "unavailable" } : state;

    case "reveal":
      return state.status === "unavailable" ? { ...state, status: "revealed" } : state;
  }
}

export function isBlurred(status: BlurStatus): boolean {
  return status !== "safe" && status !== "revealed";
}

/** Delay before the next sample, by time since the call started. */
export function sampleIntervalMs(elapsedMs: number): number {
  return elapsedMs < FAST_PHASE_MS ? FAST_SAMPLE_MS : SLOW_SAMPLE_MS;
}

/* ------------------------------------------------------------------ */
/* Classifier verdict                                                  */
/* ------------------------------------------------------------------ */

/** NSFWJS class probabilities (0..1). */
export interface NsfwScores {
  Drawing: number;
  Hentai: number;
  Neutral: number;
  Porn: number;
  Sexy: number;
}

/**
 * Initial thresholds; calibrate them on the launch bias test set (LB-6).
 * Explicit classes are summed so a frame split between Porn and Hentai still counts.
 */
export const EXPLICIT_THRESHOLD = 0.35;
export const SEXY_THRESHOLD = 0.7;

export function isUnsafe(scores: NsfwScores): boolean {
  return scores.Porn + scores.Hentai >= EXPLICIT_THRESHOLD || scores.Sexy >= SEXY_THRESHOLD;
}

/* ------------------------------------------------------------------ */
/* Sampling loop                                                       */
/* ------------------------------------------------------------------ */

export type BlurSignal = "nsfw-blur" | "model-unavailable";

export interface BlurMonitorDeps {
  /** A small frame of the partner's video, or null when there is none yet. */
  grab: () => ImageData | null;
  classify: (image: ImageData) => Promise<NsfwScores>;
  /** Called when the status changes. */
  onChange: (state: BlurState) => void;
  /** Called at most once per kind (per call). */
  onSignal: (kind: BlurSignal) => void;
  timers?: Timers;
}

/**
 * Runs the blur gate for one call: samples the partner's video (fast for the
 * first 10 s, slow after), feeds the verdicts to blurReducer and reports a
 * flag and a model failure once each.
 */
export class BlurMonitor {
  private readonly deps: BlurMonitorDeps;
  private readonly timers: Timers;
  private _state: BlurState = initialBlurState;
  private startedAt = 0;
  private timer: unknown = null;
  private deadline: unknown = null;
  private stopped = false;
  private readonly signaled = new Set<BlurSignal>();

  constructor(deps: BlurMonitorDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? browserTimers;
  }

  get state(): BlurState {
    return this._state;
  }

  start(): void {
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    if (this.deadline !== null) this.timers.clearTimeout(this.deadline);
    this.timer = null;
    this.deadline = null;
  }

  /** "Tap to show video" after the model failed. */
  reveal(): void {
    this.apply({ type: "reveal" });
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
    const image = this.deps.grab();
    if (!image) {
      this.schedule(WAIT_FOR_FRAME_MS);
      return;
    }
    // The fast phase and the deadline count from the first frame, not from call
    // start: a call that is still connecting is not a model problem.
    if (this.deadline === null) {
      this.startedAt = this.timers.now();
      this.deadline = this.timers.setTimeout(() => this.apply({ type: "deadline" }), VERDICT_DEADLINE_MS);
    }
    try {
      const scores = await this.deps.classify(image);
      if (this.stopped) return;
      this.apply({ type: "frame", unsafe: isUnsafe(scores) });
    } catch {
      if (this.stopped) return;
      this.apply({ type: "model-unavailable" });
    }
    this.schedule(sampleIntervalMs(this.timers.now() - this.startedAt));
  }

  private apply(event: BlurEvent): void {
    if (this.stopped) return;
    const previous = this._state;
    this._state = blurReducer(previous, event);
    if (this._state.status === previous.status) return;
    if (this._state.status === "flagged") this.signal("nsfw-blur");
    if (this._state.status === "unavailable") this.signal("model-unavailable");
    this.deps.onChange(this._state);
  }

  private signal(kind: BlurSignal): void {
    if (this.signaled.has(kind)) return;
    this.signaled.add(kind);
    this.deps.onSignal(kind);
  }
}
