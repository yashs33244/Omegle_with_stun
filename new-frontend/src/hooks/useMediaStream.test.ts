import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describeMediaError, useMediaStream } from "./useMediaStream";

interface FakeTrack {
  kind: "audio" | "video";
  enabled: boolean;
  stop: ReturnType<typeof vi.fn>;
}

function fakeStream(withAudio = true) {
  const tracks: FakeTrack[] = [{ kind: "video", enabled: true, stop: vi.fn() }];
  if (withAudio) tracks.push({ kind: "audio", enabled: true, stop: vi.fn() });
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  };
  return { stream: stream as unknown as MediaStream, tracks };
}

const domError = (name: string) => new DOMException("failed", name);

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getUserMedia = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("describeMediaError", () => {
  it.each([
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "not-found"],
    ["NotReadableError", "in-use"],
    ["AbortError", "in-use"],
    ["MediaDevicesUnavailable", "unsupported"],
    ["SomethingElse", "unknown"],
  ])("maps %s to %s", (name, kind) => {
    const described = describeMediaError(domError(name));
    expect(described.kind).toBe(kind);
    expect(described.title).not.toBe("");
    expect(described.message).not.toBe("");
  });
});

describe("useMediaStream", () => {
  it("requests the camera once on mount and exposes the stream", async () => {
    const { stream } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    const { result } = renderHook(() => useMediaStream());

    await waitFor(() => expect(result.current.stream).toBe(stream));
    expect(result.current.hasPermission).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("reports a denied camera once and does not retry by itself", async () => {
    getUserMedia.mockRejectedValue(domError("NotAllowedError"));
    const { result } = renderHook(() => useMediaStream());

    await waitFor(() => expect(result.current.error?.kind).toBe("denied"));
    await new Promise((r) => setTimeout(r, 50));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.hasPermission).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it("retries on demand and clears the error", async () => {
    const { stream } = fakeStream();
    getUserMedia.mockRejectedValueOnce(domError("NotReadableError")).mockResolvedValueOnce(stream);
    const { result } = renderHook(() => useMediaStream());
    await waitFor(() => expect(result.current.error?.kind).toBe("in-use"));

    await act(async () => {
      await result.current.getCam();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.stream).toBe(stream);
  });

  it("falls back to video only when there is no microphone", async () => {
    const { stream } = fakeStream(false);
    getUserMedia.mockRejectedValueOnce(domError("NotFoundError")).mockResolvedValueOnce(stream);
    const { result } = renderHook(() => useMediaStream());

    await waitFor(() => expect(result.current.stream).toBe(stream));
    expect(getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ audio: false }));
  });

  it("reports no device when even video only fails", async () => {
    getUserMedia.mockRejectedValue(domError("NotFoundError"));
    const { result } = renderHook(() => useMediaStream());
    await waitFor(() => expect(result.current.error?.kind).toBe("not-found"));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("reports an unsupported browser without calling getUserMedia", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    const { result } = renderHook(() => useMediaStream());
    await waitFor(() => expect(result.current.error?.kind).toBe("unsupported"));
  });

  it("stops the tracks when stopped and when unmounted", async () => {
    const first = fakeStream();
    const second = fakeStream();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    const { result, unmount } = renderHook(() => useMediaStream());
    await waitFor(() => expect(result.current.stream).toBe(first.stream));

    act(() => result.current.stopStream());
    expect(result.current.stream).toBeNull();
    first.tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());

    await act(async () => {
      await result.current.getCam();
    });
    expect(result.current.stream).toBe(second.stream);

    unmount();
    second.tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
  });

  it("toggles mic and camera through track.enabled", async () => {
    const { stream, tracks } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    const { result } = renderHook(() => useMediaStream());
    await waitFor(() => expect(result.current.stream).toBe(stream));

    act(() => result.current.setMicEnabled(false));
    act(() => result.current.setCameraEnabled(false));

    expect(tracks.find((t) => t.kind === "audio")?.enabled).toBe(false);
    expect(tracks.find((t) => t.kind === "video")?.enabled).toBe(false);
    expect(result.current.micEnabled).toBe(false);
    expect(result.current.cameraEnabled).toBe(false);
  });
});
