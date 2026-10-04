/// <reference lib="webworker" />
/**
 * Face detector for the sender face gate: MediaPipe Tasks BlazeFace (short
 * range) on the CPU (XNNPACK wasm). Gets small frames of the LOCAL camera.
 */
import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { MODEL_PATHS } from "../modelAssets";
import type { FaceResult } from "../workerProtocol";
import { serveWorker } from "./serve";

let detector: FaceDetector | null = null;

// MediaPipe prints routine "INFO: ..." lines through console.error; keep them
// out of the error console so real errors stand out.
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("INFO:")) console.info(...args);
  else consoleError(...args);
};

serveWorker<FaceResult>({
  async load() {
    const origin = self.location.origin;
    // true: the ES module build of the wasm loader, which works inside a module worker.
    const fileset = await FilesetResolver.forVisionTasks(`${origin}${MODEL_PATHS.mediapipeWasmDir}`, true);
    detector = await FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${origin}${MODEL_PATHS.faceModel}`, delegate: "CPU" },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.5,
    });
    return "mediapipe-cpu";
  },
  run(image) {
    if (!detector) throw new Error("face detector not loaded");
    return { faces: detector.detect(image).detections.length };
  },
});
