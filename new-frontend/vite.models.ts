/**
 * Vite plugin that self-hosts the on-device moderation models under /models/.
 * - build: emits the files listed in src/moderation/modelAssets.ts into dist/;
 * - dev: serves the same paths straight from node_modules.
 * NSFWJS's base64 model scripts are converted to model.json + a .bin shard.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { COPIED_ASSETS, NSFW_MODEL_SOURCE, PINNED_PACKAGES } from "./src/moderation/modelAssets";

const require = createRequire(import.meta.url);
/** Package files by path: several packages do not export these through "exports". */
const fromNodeModules = (file: string) => fileURLToPath(new URL(`./node_modules/${file}`, import.meta.url));

interface ModelJson {
  modelTopology: unknown;
  weightsManifest: Array<{ paths: string[]; weights: unknown[] }>;
}

function checkVersions(): void {
  for (const [name, version] of Object.entries(PINNED_PACKAGES)) {
    const installed = (JSON.parse(readFileSync(fromNodeModules(`${name}/package.json`), "utf8")) as { version: string }).version;
    if (installed !== version) {
      throw new Error(`${name} is ${installed} but src/moderation/modelAssets.ts expects ${version}; update both together.`);
    }
  }
}

/** Every generated file: published path (no leading slash) -> contents. */
function buildAssets(): Map<string, Buffer | string> {
  checkVersions();
  const files = new Map<string, Buffer | string>();
  for (const asset of COPIED_ASSETS) {
    files.set(asset.path.replace(/^\//, ""), readFileSync(fromNodeModules(asset.from)));
  }

  // The UMD scripts assign module.exports when loaded through require().
  const model = require(fromNodeModules(NSFW_MODEL_SOURCE.modelScript)) as ModelJson;
  const dir = NSFW_MODEL_SOURCE.dir.replace(/^\//, "");
  const manifest = model.weightsManifest.map((group) => ({
    ...group,
    paths: group.paths.map((p) => `${p}.bin`),
  }));
  const shardNames = model.weightsManifest.flatMap((g) => g.paths);
  if (shardNames.length !== NSFW_MODEL_SOURCE.shardScripts.length) {
    throw new Error(`NSFWJS model lists ${shardNames.length} shards, modelAssets.ts has ${NSFW_MODEL_SOURCE.shardScripts.length}`);
  }
  shardNames.forEach((name, i) => {
    const base64 = require(fromNodeModules(NSFW_MODEL_SOURCE.shardScripts[i]!)) as string;
    files.set(`${dir}${name}.bin`, Buffer.from(base64, "base64"));
  });
  files.set(`${dir}model.json`, JSON.stringify({ modelTopology: model.modelTopology, weightsManifest: manifest }));
  return files;
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".bin": "application/octet-stream",
};

export function selfHostedModels(): Plugin {
  let files: Map<string, Buffer | string> | null = null;
  const assets = () => (files ??= buildAssets());

  return {
    name: "chizzy-self-hosted-models",
    generateBundle() {
      for (const [fileName, source] of assets()) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0]!.replace(/^\//, "");
        const body = path.startsWith("models/") ? assets().get(path) : undefined;
        if (body === undefined) return next();
        const ext = path.slice(path.lastIndexOf("."));
        res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
        res.end(body);
      });
    },
  };
}
