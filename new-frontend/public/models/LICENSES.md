# Self-hosted moderation models

Everything under `/models/` is served from Chizzy's own origin so the browser
never fetches model code or weights from a third-party CDN. Paths carry a
version, so these files can be cached as immutable.

| Published path | Source | Size (approx.) | License |
|---|---|---|---|
| `face-v1/blaze_face_short_range.tflite` | MediaPipe BlazeFace short range, float16, version 1. Downloaded from `storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/` (SHA-256 `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f`). Committed in this folder. | 230 KB | Apache-2.0 (MediaPipe model card) |
| `mediapipe-1.0.1/vision_wasm_module_internal.{js,wasm}` | npm `@mediapipe/tasks-vision@1.0.1`, copied at build time by `vite.models.ts` | 12 MB wasm + 0.3 MB js | Apache-2.0 |
| `nsfwjs-4.4.0/mobilenet_v2/{model.json,group1-shard1of1.bin}` | npm `nsfwjs@4.4.0` MobileNetV2 model, converted from its base64 scripts at build time | 2.6 MB | MIT (Infinite Red) |
| `tfjs-wasm-4.22.0/*.wasm` | npm `@tensorflow/tfjs-backend-wasm@4.22.0`, copied at build time | 0.3 to 0.4 MB each, one is used | Apache-2.0 |

Only the face model is committed; the rest is generated into `dist/models/` by
the build, so updating a package means updating `src/moderation/modelAssets.ts`
(the build fails if the installed version and the path disagree).
