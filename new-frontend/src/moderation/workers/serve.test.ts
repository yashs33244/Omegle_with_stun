import { afterEach, describe, expect, test, vi } from "vitest";
import { serveWorker } from "./serve";

class FakeImageData {}

function setup() {
  const posted: { type: string }[] = [];
  const scope = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: (m: { type: string }) => posted.push(m),
    location: { origin: "https://chizzy.test" },
  };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("ImageData", FakeImageData);
  const run = vi.fn(() => "ok");
  serveWorker({ load: async () => "cpu", run });
  // Messages from the creating page reach a dedicated worker with an empty origin.
  const send = (data: unknown, origin = "") => scope.onmessage!({ data, origin } as MessageEvent);
  return { posted, run, send };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("serveWorker", () => {
  test("runs well-formed requests and ignores anything else", async () => {
    const { posted, run, send } = setup();
    for (const bad of [null, "run", {}, { type: "eval" }, { type: "run", id: "1", image: new FakeImageData() }, { type: "run", id: 1, image: {} }]) {
      send(bad);
    }
    const image = new FakeImageData();
    send({ type: "run", id: 6, image }, "https://evil.example");
    send({ type: "run", id: 7, image });
    await vi.waitFor(() => expect(posted).toContainEqual({ type: "result", id: 7, result: "ok" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(image);
    expect(posted.filter((m) => m.type !== "loaded")).toEqual([{ type: "result", id: 7, result: "ok" }]);
  });
});
