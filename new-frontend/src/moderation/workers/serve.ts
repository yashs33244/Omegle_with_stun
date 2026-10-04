/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse } from "../workerProtocol";

interface WorkerTask<R> {
  /** Loads the model; returns the backend name for the logs. */
  load: () => Promise<string>;
  run: (image: ImageData) => Promise<R> | R;
}

/**
 * Wires a model into the worker message loop. Loading happens once; "run"
 * requests that arrive before it finishes wait for it. Requests are handled
 * one at a time, in order.
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

  scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
    const msg = e.data;
    if (msg.type === "load") {
      ensureLoaded().catch(() => {
        // Reported through "load-error".
      });
      return;
    }
    chain = chain.then(async () => {
      try {
        await ensureLoaded();
        post({ type: "result", id: msg.id, result: await task.run(msg.image) });
      } catch (err) {
        post({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
      }
    });
  };
}
