/**
 * Page-side handle on one moderation worker. The worker is created on the
 * first load() (preload during onboarding) and shared by every hook after
 * that. Each run() transfers a small frame to the worker and waits for the
 * verdict, with a timeout so a stuck model cannot hold the blur gate forever.
 */
import { pageIdle } from "@/lib/idle";
import type { FaceResult, NsfwResult, WorkerRequest, WorkerResponse } from "./workerProtocol";

export type ModelStatus = "idle" | "loading" | "ready" | "failed";

/** The parts of Worker this client uses (tests pass a fake). */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

export const RUN_TIMEOUT_MS = 5000;

interface Pending<R> {
  resolve: (result: R) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ModelClient<R> {
  readonly name: string;
  private readonly createWorker: () => WorkerLike;
  private readonly runTimeoutMs: number;
  private worker: WorkerLike | null = null;
  private loadPromise: Promise<void> | null = null;
  private loadSettle: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private readonly pending = new Map<number, Pending<R>>();
  private seq = 0;
  private _status: ModelStatus = "idle";
  private _loadMs: number | null = null;
  private _backend: string | null = null;

  constructor(name: string, createWorker: () => WorkerLike, runTimeoutMs = RUN_TIMEOUT_MS) {
    this.name = name;
    this.createWorker = createWorker;
    this.runTimeoutMs = runTimeoutMs;
  }

  get status(): ModelStatus {
    return this._status;
  }
  /** Load time measured inside the worker (fetch + compile + warm-up). */
  get loadMs(): number | null {
    return this._loadMs;
  }
  get backend(): string | null {
    return this._backend;
  }

  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this._status = "loading";
    this.loadPromise = new Promise<void>((resolve, reject) => {
      this.loadSettle = { resolve, reject };
    });
    // Callers that only preload must not see an unhandled rejection.
    this.loadPromise.catch(() => {});
    try {
      const worker = this.createWorker();
      this.worker = worker;
      worker.onmessage = (e) => this.onMessage(e.data as WorkerResponse<R>);
      worker.onerror = (e) => {
        const message = e.message || "worker failed to start";
        this.fail(new Error(message));
      };
      worker.postMessage({ type: "load" });
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
    return this.loadPromise;
  }

  async run(image: ImageData): Promise<R> {
    await this.load();
    const worker = this.worker;
    if (!worker || this._status !== "ready") throw new Error(`${this.name} model is not available`);
    const id = ++this.seq;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} model timed out`));
      }, this.runTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type: "run", id, image }, [image.data.buffer]);
    });
  }

  private onMessage(msg: WorkerResponse<R>): void {
    switch (msg.type) {
      case "loaded":
        this._status = "ready";
        this._loadMs = msg.ms;
        this._backend = msg.backend;
        console.info(`[moderation] ${this.name} model ready in ${msg.ms} ms (${msg.backend})`);
        this.loadSettle?.resolve();
        break;
      case "load-error":
        this.fail(new Error(msg.message));
        break;
      case "result":
      case "error": {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.type === "result") entry.resolve(msg.result);
        else entry.reject(new Error(msg.message));
        break;
      }
    }
  }

  private fail(err: Error): void {
    if (this._status === "failed") return;
    this._status = "failed";
    console.warn(`[moderation] ${this.name} model unavailable: ${err.message}`);
    this.loadSettle?.reject(err);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}

/* ------------------------------------------------------------------ */
/* The two shared models                                               */
/* ------------------------------------------------------------------ */

let faceClient: ModelClient<FaceResult> | null = null;
let nsfwClient: ModelClient<NsfwResult> | null = null;

export function faceModel(): ModelClient<FaceResult> {
  faceClient ??= new ModelClient<FaceResult>(
    "face",
    () => new Worker(new URL("./workers/face.worker.ts", import.meta.url), { type: "module", name: "chizzy-face" }),
  );
  return faceClient;
}

export function nsfwModel(): ModelClient<NsfwResult> {
  nsfwClient ??= new ModelClient<NsfwResult>(
    "nsfw",
    () => new Worker(new URL("./workers/nsfw.worker.ts", import.meta.url), { type: "module", name: "chizzy-nsfw" }),
  );
  return nsfwClient;
}

/** Upper bound on how long preloadModels() waits for an idle moment after the page has loaded. */
const PRELOAD_IDLE_TIMEOUT_MS = 2000;

/**
 * Starts downloading and compiling both models (call from the start screen).
 * Deferred until the page is idle so the ~15 MB of models and their wasm
 * compile never compete with the first paint; a call that starts earlier
 * loads them at once through the hooks' own load() calls.
 */
export function preloadModels(): void {
  if (typeof Worker === "undefined") return;
  void pageIdle(PRELOAD_IDLE_TIMEOUT_MS).then(() => {
    void faceModel().load();
    void nsfwModel().load();
  });
}
