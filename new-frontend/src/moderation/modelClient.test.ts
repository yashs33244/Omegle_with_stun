import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelClient, type WorkerLike } from "./modelClient";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";
import { isVirtualCameraLabel } from "./virtualCamera";

class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  sent: WorkerRequest[] = [];
  terminated = false;
  postMessage(message: WorkerRequest) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(msg: WorkerResponse<{ faces: number }>) {
    this.onmessage?.({ data: msg } as MessageEvent);
  }
}

const image = () => ({ data: { buffer: new ArrayBuffer(4) } }) as unknown as ImageData;

afterEach(() => {
  vi.useRealTimers();
});

describe("ModelClient", () => {
  it("loads once, runs requests and logs the load time", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const worker = new FakeWorker();
    const create = vi.fn(() => worker);
    const client = new ModelClient<{ faces: number }>("face", create);
    const loading = client.load();
    expect(client.load()).toBe(loading);
    expect(create).toHaveBeenCalledTimes(1);
    expect(worker.sent).toEqual([{ type: "load" }]);
    worker.reply({ type: "loaded", ms: 420, backend: "webgl" });
    await loading;
    expect(client.status).toBe("ready");
    expect(client.loadMs).toBe(420);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("420 ms"));

    const result = client.run(image());
    await Promise.resolve();
    await Promise.resolve();
    const run = worker.sent[1] as Extract<WorkerRequest, { type: "run" }>;
    expect(run.type).toBe("run");
    worker.reply({ type: "result", id: run.id, result: { faces: 1 } });
    await expect(result).resolves.toEqual({ faces: 1 });
  });

  it("fails every caller when the model cannot load, and terminates the worker", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const worker = new FakeWorker();
    const client = new ModelClient<{ faces: number }>("face", () => worker);
    const run = client.run(image());
    worker.reply({ type: "load-error", message: "CSP blocked wasm" });
    await expect(run).rejects.toThrow("CSP blocked wasm");
    expect(client.status).toBe("failed");
    expect(worker.terminated).toBe(true);
    await expect(client.run(image())).rejects.toThrow();
  });

  it("treats a worker that cannot start as unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const worker = new FakeWorker();
    const client = new ModelClient<{ faces: number }>("nsfw", () => worker);
    const loading = client.load();
    worker.onerror?.(new Event("error") as ErrorEvent);
    await expect(loading).rejects.toThrow();
    expect(client.status).toBe("failed");
  });

  it("times out a stuck request", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new ModelClient<{ faces: number }>("face", () => worker, 1000);
    const loading = client.load();
    worker.reply({ type: "loaded", ms: 1, backend: "cpu" });
    await loading;
    const result = client.run(image());
    const assertion = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});

describe("isVirtualCameraLabel", () => {
  it.each(["OBS Virtual Camera", "ManyCam Virtual Webcam", "XSplit VCam", "Snap Camera", "CamTwist"])("flags %s", (label) => {
    expect(isVirtualCameraLabel(label)).toBe(true);
  });

  it.each(["FaceTime HD Camera", "Integrated Webcam", "", null])("passes %s", (label) => {
    expect(isVirtualCameraLabel(label)).toBe(false);
  });
});
