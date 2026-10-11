import { describe, expect, it, vi } from "vitest";
import { fakeTimers } from "@/test/fakeTimers";
import {
  BlurMonitor,
  FAST_SAMPLE_MS,
  SLOW_SAMPLE_MS,
  VERDICT_DEADLINE_MS,
  blurReducer,
  initialBlurState,
  isBlurred,
  isUnsafe,
  sampleIntervalMs,
  type BlurEvent,
  type BlurState,
  type NsfwScores,
} from "./blurGate";

const SAFE: NsfwScores = { Drawing: 0.1, Hentai: 0, Neutral: 0.9, Porn: 0, Sexy: 0 };
const PORN: NsfwScores = { Drawing: 0, Hentai: 0.1, Neutral: 0.1, Porn: 0.8, Sexy: 0 };

const run = (events: BlurEvent[], from: BlurState = initialBlurState) => events.reduce(blurReducer, from);
const safe: BlurEvent = { type: "frame", unsafe: false };
const unsafe: BlurEvent = { type: "frame", unsafe: true };

describe("blurReducer", () => {
  it("starts blurred and unblurs only after 3 consecutive safe frames", () => {
    expect(isBlurred(initialBlurState.status)).toBe(true);
    expect(run([safe, safe]).status).toBe("checking");
    expect(run([safe, safe, safe]).status).toBe("safe");
    expect(isBlurred("safe")).toBe(false);
  });

  it("hides the video on a flagged frame and keeps it hidden for the call", () => {
    expect(run([safe, unsafe, safe, safe, safe]).status).toBe("flagged");
    expect(run([safe, safe, safe, unsafe]).status).toBe("flagged");
    expect(isBlurred("flagged")).toBe(true);
  });

  it("falls back to tap-to-show when the model is unavailable, never a timed unblur", () => {
    const failed = run([{ type: "model-unavailable" }]);
    expect(failed.status).toBe("unavailable");
    expect(isBlurred(failed.status)).toBe(true);
    expect(run([{ type: "deadline" }]).status).toBe("unavailable");
    const revealed = run([{ type: "reveal" }], failed);
    expect(revealed.status).toBe("revealed");
    expect(isBlurred(revealed.status)).toBe(false);
  });

  it("only reveals from the fallback state", () => {
    expect(run([{ type: "reveal" }]).status).toBe("checking");
    expect(run([unsafe, { type: "reveal" }]).status).toBe("flagged");
  });

  it("re-blurs a shown video when the model stops working", () => {
    expect(run([safe, safe, safe, { type: "model-unavailable" }]).status).toBe("unavailable");
  });

  it("ignores the deadline once there is a verdict", () => {
    expect(run([safe, safe, safe, { type: "deadline" }]).status).toBe("safe");
  });

  it("can still unblur from the fallback when the model recovers, and still flags after a reveal", () => {
    expect(run([{ type: "deadline" }, safe, safe, safe]).status).toBe("safe");
    expect(run([{ type: "model-unavailable" }, { type: "reveal" }, unsafe]).status).toBe("flagged");
  });
});

describe("verdict and sampling", () => {
  it("flags explicit and very suggestive frames", () => {
    expect(isUnsafe(SAFE)).toBe(false);
    expect(isUnsafe(PORN)).toBe(true);
    expect(isUnsafe({ Drawing: 0, Hentai: 0.2, Neutral: 0.6, Porn: 0.2, Sexy: 0 })).toBe(true);
    expect(isUnsafe({ Drawing: 0, Hentai: 0, Neutral: 0.2, Porn: 0, Sexy: 0.8 })).toBe(true);
    expect(isUnsafe({ Drawing: 0, Hentai: 0, Neutral: 0.5, Porn: 0, Sexy: 0.5 })).toBe(false);
  });

  it("samples about 2 fps for 10 s, then about 0.5 fps", () => {
    expect(sampleIntervalMs(0)).toBe(FAST_SAMPLE_MS);
    expect(sampleIntervalMs(9_999)).toBe(FAST_SAMPLE_MS);
    expect(sampleIntervalMs(10_000)).toBe(SLOW_SAMPLE_MS);
  });
});

describe("BlurMonitor", () => {
  const frame = () => ({ data: new Uint8ClampedArray(4) }) as unknown as ImageData;

  function setup(classify: (image: ImageData) => Promise<NsfwScores>, grab: () => ImageData | null = frame) {
    const t = fakeTimers();
    const onChange = vi.fn();
    const onSignal = vi.fn();
    const classifySpy = vi.fn(classify);
    const monitor = new BlurMonitor({ grab, classify: classifySpy, onChange, onSignal, timers: t.timers });
    monitor.start();
    return { monitor, onChange, onSignal, classify: classifySpy, ...t };
  }

  it("unblurs after three safe samples, about 1.5 s", async () => {
    const { monitor, onChange, advanceAsync } = setup(async () => SAFE);
    await advanceAsync(FAST_SAMPLE_MS * 2 + 200);
    expect(monitor.state.status).toBe("safe");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("re-blurs on a flag and signals nsfw-blur once", async () => {
    let scores = SAFE;
    const { monitor, onSignal, advanceAsync } = setup(async () => scores);
    await advanceAsync(2_000);
    expect(monitor.state.status).toBe("safe");
    scores = PORN;
    await advanceAsync(2_000);
    expect(monitor.state.status).toBe("flagged");
    await advanceAsync(5_000);
    expect(onSignal.mock.calls).toEqual([["nsfw-blur"]]);
  });

  it("slows down to one sample every 2 s after the first 10 s", async () => {
    const { classify, advanceAsync } = setup(async () => SAFE);
    await advanceAsync(10_000);
    const fast = classify.mock.calls.length;
    expect(fast).toBeGreaterThanOrEqual(19);
    await advanceAsync(10_000);
    expect(classify.mock.calls.length - fast).toBeLessThanOrEqual(6);
  });

  it("waits for the first frame without starting the deadline", async () => {
    let hasFrame = false;
    const { monitor, classify, advanceAsync } = setup(async () => SAFE, () => (hasFrame ? frame() : null));
    await advanceAsync(VERDICT_DEADLINE_MS * 2);
    expect(classify).not.toHaveBeenCalled();
    expect(monitor.state.status).toBe("checking");
    hasFrame = true;
    await advanceAsync(2_000);
    expect(monitor.state.status).toBe("safe");
  });

  it("falls back to tap-to-show and signals model-unavailable once when the model fails", async () => {
    const { monitor, onSignal, advanceAsync } = setup(async () => {
      throw new Error("no model");
    });
    await advanceAsync(5_000);
    expect(monitor.state.status).toBe("unavailable");
    expect(onSignal.mock.calls).toEqual([["model-unavailable"]]);
    monitor.reveal();
    expect(monitor.state.status).toBe("revealed");
  });

  it("offers tap-to-show when the model is still loading 10 s after the first frame", async () => {
    const { monitor, onSignal, advanceAsync } = setup(() => new Promise<NsfwScores>(() => {}));
    await advanceAsync(VERDICT_DEADLINE_MS - 100);
    expect(monitor.state.status).toBe("checking");
    await advanceAsync(200);
    expect(monitor.state.status).toBe("unavailable");
    expect(onSignal).toHaveBeenCalledWith("model-unavailable");
  });

  it("does nothing after stop()", async () => {
    const { monitor, onChange, classify, advanceAsync } = setup(async () => SAFE);
    monitor.stop();
    await advanceAsync(5_000);
    expect(classify).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
