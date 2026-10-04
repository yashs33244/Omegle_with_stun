/// <reference lib="webworker" />
/**
 * NSFW classifier for the receiver blur: NSFWJS MobileNetV2 (224 px) on
 * TensorFlow.js. Tries WebGL first, then wasm, then the plain CPU backend.
 * Gets small frames of the PARTNER's video and partner profile photos.
 */
import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import { NSFWJS } from "nsfwjs/core";
import { MODEL_PATHS } from "../modelAssets";
import type { NsfwResult } from "../workerProtocol";
import { serveWorker } from "./serve";

const BACKENDS = ["webgl", "wasm", "cpu"] as const;
let model: NSFWJS | null = null;

/**
 * True when WebGL is a software rasterizer (SwiftShader, llvmpipe): the GPU is
 * blocklisted or absent, and the wasm backend is much faster than WebGL then.
 */
function softwareWebGL(): boolean {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext("webgl2") ?? new OffscreenCanvas(1, 1).getContext("webgl");
    if (!gl) return true;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    return /swiftshader|llvmpipe|software/i.test(renderer);
  } catch {
    return true;
  }
}

async function loadOn(backend: (typeof BACKENDS)[number]): Promise<NSFWJS> {
  if (!(await tf.setBackend(backend))) throw new Error(`${backend} backend unavailable`);
  await tf.ready();
  const nsfw = new NSFWJS(`${self.location.origin}${MODEL_PATHS.nsfwModelDir}model.json`, { size: 224 });
  // load() also runs one warm-up prediction, so a backend that cannot execute fails here.
  await nsfw.load();
  return nsfw;
}

serveWorker<NsfwResult>({
  async load() {
    setWasmPaths(`${self.location.origin}${MODEL_PATHS.tfjsWasmDir}`);
    const errors: string[] = [];
    const backends = softwareWebGL() ? BACKENDS.filter((b) => b !== "webgl") : BACKENDS;
    for (const backend of backends) {
      try {
        model = await loadOn(backend);
        return backend;
      } catch (err) {
        errors.push(`${backend}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`no TensorFlow.js backend could run the model (${errors.join("; ")})`);
  },
  async run(image) {
    if (!model) throw new Error("NSFW model not loaded");
    const predictions = await model.classify(image, 5);
    const scores: NsfwResult["scores"] = { Drawing: 0, Hentai: 0, Neutral: 0, Porn: 0, Sexy: 0 };
    for (const p of predictions) scores[p.className as keyof NsfwResult["scores"]] = p.probability;
    return { scores };
  },
});
