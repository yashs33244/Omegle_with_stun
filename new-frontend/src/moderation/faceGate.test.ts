import { describe, expect, it, vi } from "vitest";
import { fakeTimers } from "@/test/fakeTimers";
import { FACE_SAMPLE_MS, FaceGateMonitor, NO_FACE_PAUSE_MS, faceGateReducer, initialFaceGateState } from "./faceGate";

describe("faceGateReducer", () => {
  const started = faceGateReducer(initialFaceGateState, { type: "start", at: 0 });

  it("pauses after 3 s without a face and counts the episode", () => {
    const early = faceGateReducer(started, { type: "detection", face: false, at: NO_FACE_PAUSE_MS - 1 });
    expect(early.paused).toBe(false);
    const late = faceGateReducer(early, { type: "detection", face: false, at: NO_FACE_PAUSE_MS });
    expect(late).toMatchObject({ paused: true, episodes: 1 });
    // Still no face: the same episode.
    expect(faceGateReducer(late, { type: "detection", face: false, at: 9_000 }).episodes).toBe(1);
  });

  it("resumes as soon as a face is back, and a new pause is a new episode", () => {
    let s = faceGateReducer(started, { type: "detection", face: false, at: 3_000 });
    s = faceGateReducer(s, { type: "detection", face: true, at: 3_500 });
    expect(s.paused).toBe(false);
    s = faceGateReducer(s, { type: "detection", face: false, at: 5_000 });
    expect(s.paused).toBe(false);
    s = faceGateReducer(s, { type: "detection", face: false, at: 6_500 });
    expect(s).toMatchObject({ paused: true, episodes: 2 });
  });

  it("fails open: an unavailable or stopped detector never pauses", () => {
    const paused = faceGateReducer(started, { type: "detection", face: false, at: 4_000 });
    expect(faceGateReducer(paused, { type: "unavailable" }).paused).toBe(false);
    expect(faceGateReducer(paused, { type: "stop" }).paused).toBe(false);
    const off = faceGateReducer(initialFaceGateState, { type: "detection", face: false, at: 10_000 });
    expect(off.paused).toBe(false);
  });
});

describe("FaceGateMonitor with a mocked detector", () => {
  const frame = () => ({ data: new Uint8ClampedArray(4) }) as unknown as ImageData;

  function setup(opts: { load?: () => Promise<void>; face?: () => boolean; detectError?: boolean } = {}) {
    const t = fakeTimers();
    let face = opts.face ?? (() => true);
    const onPausedChange = vi.fn();
    const onUnavailable = vi.fn();
    const detect = vi.fn(async () => {
      if (opts.detectError) throw new Error("detector crashed");
      return face();
    });
    const monitor = new FaceGateMonitor({
      load: opts.load ?? (async () => {}),
      grab: frame,
      detect,
      onPausedChange,
      onUnavailable,
      timers: t.timers,
    });
    return {
      monitor,
      detect,
      onPausedChange,
      onUnavailable,
      setFace: (f: () => boolean) => {
        face = f;
      },
      ...t,
    };
  }

  it("checks about twice a second", async () => {
    const { monitor, detect, advanceAsync } = setup();
    await monitor.start();
    await advanceAsync(5_000);
    expect(detect.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(detect.mock.calls.length).toBeLessThanOrEqual(11);
    expect(FACE_SAMPLE_MS).toBe(500);
  });

  it("pauses after 3 s without a face and resumes when the face is back", async () => {
    const { monitor, onPausedChange, setFace, advanceAsync } = setup({ face: () => false });
    await monitor.start();
    await advanceAsync(2_900);
    expect(onPausedChange).not.toHaveBeenCalled();
    await advanceAsync(600);
    expect(onPausedChange).toHaveBeenLastCalledWith(true, 1);
    setFace(() => true);
    await advanceAsync(600);
    expect(onPausedChange).toHaveBeenLastCalledWith(false, 1);
    expect(monitor.state.paused).toBe(false);
  });

  it("never pauses while a face is visible", async () => {
    const { monitor, onPausedChange, advanceAsync } = setup();
    await monitor.start();
    await advanceAsync(20_000);
    expect(onPausedChange).not.toHaveBeenCalled();
  });

  it("fails open when the model cannot load", async () => {
    const { monitor, detect, onUnavailable, onPausedChange, advanceAsync } = setup({
      load: async () => {
        throw new Error("no wasm");
      },
    });
    await monitor.start();
    await advanceAsync(10_000);
    expect(detect).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onPausedChange).not.toHaveBeenCalled();
  });

  it("restores the video when the detector crashes mid-pause", async () => {
    let calls = 0;
    const { monitor, onPausedChange, detect, onUnavailable, advanceAsync } = setup({
      face: () => {
        calls += 1;
        if (calls > 8) throw new Error("crash");
        return false;
      },
    });
    await monitor.start();
    await advanceAsync(4_000);
    expect(onPausedChange).toHaveBeenLastCalledWith(true, 1);
    await advanceAsync(2_000);
    expect(onPausedChange).toHaveBeenLastCalledWith(false, 1);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    const after = detect.mock.calls.length;
    await advanceAsync(5_000);
    expect(detect.mock.calls.length).toBe(after);
  });

  it("stop() ends a pause and the loop", async () => {
    const { monitor, onPausedChange, detect, advanceAsync } = setup({ face: () => false });
    await monitor.start();
    await advanceAsync(4_000);
    monitor.stop();
    expect(onPausedChange).toHaveBeenLastCalledWith(false, 1);
    const after = detect.mock.calls.length;
    await advanceAsync(5_000);
    expect(detect.mock.calls.length).toBe(after);
  });
});
