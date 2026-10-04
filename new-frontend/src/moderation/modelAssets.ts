/**
 * Where the on-device moderation models live. Everything is self-hosted under
 * /models/ (no third-party CDN, CSP friendly). Paths carry the package version
 * so the files can be cached as immutable.
 *
 * The vendored files are copied out of node_modules by vite.models.ts at build
 * time (and served from node_modules by the dev server); the face model, which
 * is not on npm, is committed under public/models/. See public/models/LICENSES.md.
 *
 * Plain data with no DOM or Node imports: vite.models.ts imports it too.
 */

export const MEDIAPIPE_VERSION = "1.0.1";
export const NSFWJS_VERSION = "4.4.0";
export const TFJS_VERSION = "4.22.0";

export const MODEL_PATHS = {
  /** MediaPipe Tasks Vision wasm (module build, loaded by the face worker). */
  mediapipeWasmDir: `/models/mediapipe-${MEDIAPIPE_VERSION}`,
  /** BlazeFace short range, float16, version 1 (committed, Apache-2.0). */
  faceModel: "/models/face-v1/blaze_face_short_range.tflite",
  /** NSFWJS MobileNetV2 (224 px) as a TFJS layers model. */
  nsfwModelDir: `/models/nsfwjs-${NSFWJS_VERSION}/mobilenet_v2/`,
  /** TFJS wasm backend binaries (fallback when WebGL is unavailable in the worker). */
  tfjsWasmDir: `/models/tfjs-wasm-${TFJS_VERSION}/`,
} as const;

/** Files copied verbatim from node_modules: published path -> package-relative source. */
export const COPIED_ASSETS: Array<{ path: string; from: string }> = [
  { path: `${MODEL_PATHS.mediapipeWasmDir}/vision_wasm_module_internal.js`, from: "@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.js" },
  { path: `${MODEL_PATHS.mediapipeWasmDir}/vision_wasm_module_internal.wasm`, from: "@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.wasm" },
  { path: `${MODEL_PATHS.tfjsWasmDir}tfjs-backend-wasm.wasm`, from: "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm" },
  { path: `${MODEL_PATHS.tfjsWasmDir}tfjs-backend-wasm-simd.wasm`, from: "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm" },
  {
    path: `${MODEL_PATHS.tfjsWasmDir}tfjs-backend-wasm-threaded-simd.wasm`,
    from: "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm",
  },
];

/**
 * NSFWJS ships its models as base64 inside UMD scripts. vite.models.ts turns
 * this one into a regular model.json plus a binary weight shard.
 */
export const NSFW_MODEL_SOURCE = {
  modelScript: "nsfwjs/dist/models/mobilenet_v2/model.min.js",
  shardScripts: ["nsfwjs/dist/models/mobilenet_v2/group1-shard1of1.min.js"],
  dir: MODEL_PATHS.nsfwModelDir,
} as const;

/** Package versions the paths above were written for; the build fails on a mismatch. */
export const PINNED_PACKAGES: Record<string, string> = {
  "@mediapipe/tasks-vision": MEDIAPIPE_VERSION,
  nsfwjs: NSFWJS_VERSION,
  "@tensorflow/tfjs-backend-wasm": TFJS_VERSION,
  "@tensorflow/tfjs": TFJS_VERSION,
};
