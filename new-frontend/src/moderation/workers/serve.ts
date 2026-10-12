/// <reference lib="webworker" />
import type { WorkerResponse } from "../workerProtocol";

interface WorkerTask<R> {
  /** Loads the model; returns the backend name for the logs. */
  load: () => Promise<string>;
  run: (image: ImageData) => Promise<R> | R;
}

/**
 * Wires a model into the worker message loop. Loading happens once; "run"
 * requests that arrive before it finishes wait for it. Requests are handled
 * one at a time, in order. This is a dedicated worker, so only the page that
 * created it can post here; messages that are not a `WorkerRequest` are ignored.
 */
export function serveWorker<R>(task: WorkerTask<R>): void {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  const post = (msg: WorkerResponse<R>) => scope.postMessage(msg);
  let loading: Promise<void> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const ensureLoaded = () => {
    loading ??= (async () => {
      const started = performance.now();
      try {
        const backend = await task.load();
        post({ type: "loaded", ms: Math.round(performance.now() - started), backend });
      } catch (err) {
        post({ type: "load-error", message: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    })();
    return loading;
  };

  scope.onmessage = (e: MessageEvent<unknown>) => {
    const msg = e.data;
    if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
    if (msg.type === "load") {
      ensureLoaded().catch(() => {
        // Reported through "load-error".
      });
      return;
    }
    if (msg.type !== "run" || !("id" in msg) || !("image" in msg)) return;
    const { id, image } = msg;
    if (typeof id !== "number" || !(image instanceof ImageData)) return;
    chain = chain.then(async () => {
      try {
        await ensureLoaded();
        post({ type: "result", id, result: await task.run(image) });
      } catch (err) {
        post({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
      }
    });
  };
}
