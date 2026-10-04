import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "./protocol";
import {
  PHOTO_MAX_SIDE,
  PHOTO_QUALITY,
  PhotoCaptureError,
  captureVideoFrame,
  isAcceptablePhoto,
  squareCrop,
} from "./photo";

function fakeCanvas(dataUrl: string | ((type: string, q: number) => string), withContext = true) {
  const drawImage = vi.fn();
  const toDataURL = vi.fn(typeof dataUrl === "string" ? () => dataUrl : dataUrl);
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => (withContext ? { drawImage } : null)),
    toDataURL,
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, raw: canvas, drawImage, toDataURL };
}

function fakeVideo(videoWidth: number, videoHeight: number) {
  return { videoWidth, videoHeight } as unknown as HTMLVideoElement;
}

const smallJpeg = `data:image/jpeg;base64,${"A".repeat(1000)}`;

describe("squareCrop", () => {
  it("takes a centered square from a landscape frame and scales it to 256", () => {
    expect(squareCrop(1280, 720)).toEqual({ sx: 280, sy: 0, sSize: 720, size: PHOTO_MAX_SIDE });
  });

  it("takes a centered square from a portrait frame", () => {
    expect(squareCrop(480, 640)).toEqual({ sx: 0, sy: 80, sSize: 480, size: PHOTO_MAX_SIDE });
  });

  it("never upscales a small frame", () => {
    expect(squareCrop(160, 120)).toEqual({ sx: 20, sy: 0, sSize: 120, size: 120 });
  });
});

describe("captureVideoFrame", () => {
  it("draws a downscaled square and encodes JPEG at quality 0.8", () => {
    const { canvas, raw, drawImage, toDataURL } = fakeCanvas(smallJpeg);
    const video = fakeVideo(1280, 720);

    const url = captureVideoFrame(video, canvas);

    expect(url).toBe(smallJpeg);
    expect(raw.width).toBe(256);
    expect(raw.height).toBe(256);
    expect(raw.width).toBeLessThanOrEqual(PHOTO_MAX_SIDE);
    expect(drawImage).toHaveBeenCalledWith(video, 280, 0, 720, 720, 0, 0, 256, 256);
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", PHOTO_QUALITY);
    expect(PHOTO_QUALITY).toBe(0.8);
  });

  it("rejects a video that has no frame yet", () => {
    const { canvas, drawImage } = fakeCanvas(smallJpeg);
    expect(() => captureVideoFrame(fakeVideo(0, 0), canvas)).toThrow(PhotoCaptureError);
    expect(() => captureVideoFrame(fakeVideo(0, 0), canvas)).toThrow(
      expect.objectContaining({ reason: "not-ready" }),
    );
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("rejects a result over LIMITS.photoMaxChars", () => {
    const huge = `data:image/jpeg;base64,${"A".repeat(LIMITS.photoMaxChars)}`;
    const { canvas } = fakeCanvas(huge);
    expect(() => captureVideoFrame(fakeVideo(640, 480), canvas)).toThrow(
      expect.objectContaining({ reason: "too-large" }),
    );
  });

  it("accepts a result exactly at the limit", () => {
    const prefix = "data:image/jpeg;base64,";
    const exact = prefix + "A".repeat(LIMITS.photoMaxChars - prefix.length);
    const { canvas } = fakeCanvas(exact);
    expect(captureVideoFrame(fakeVideo(640, 480), canvas)).toHaveLength(LIMITS.photoMaxChars);
  });

  it("rejects a browser that falls back to another format", () => {
    const { canvas } = fakeCanvas("data:image/png;base64,AAAA");
    expect(() => captureVideoFrame(fakeVideo(640, 480), canvas)).toThrow(
      expect.objectContaining({ reason: "encode-failed" }),
    );
  });

  it("rejects when no 2d context is available", () => {
    const { canvas } = fakeCanvas(smallJpeg, false);
    expect(() => captureVideoFrame(fakeVideo(640, 480), canvas)).toThrow(
      expect.objectContaining({ reason: "encode-failed" }),
    );
  });
});

describe("isAcceptablePhoto", () => {
  it("accepts inline JPEG data under the limit", () => {
    expect(isAcceptablePhoto(smallJpeg)).toBe(true);
  });

  it("rejects remote URLs and oversized data", () => {
    expect(isAcceptablePhoto("https://example.com/me.jpg")).toBe(false);
    expect(isAcceptablePhoto(`data:image/jpeg;base64,${"A".repeat(LIMITS.photoMaxChars)}`)).toBe(false);
  });
});
