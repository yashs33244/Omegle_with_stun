import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "./protocol";
import { buildEvidence, captureEvidenceFrame, evidenceChat, evidenceSize } from "./evidence";
import type { ChatEntry } from "@/hooks/useSignaling";

const jpeg = (chars: number) => `data:image/jpeg;base64,${"A".repeat(chars)}`;

function fakeCanvas(toDataURL: (type: string, quality: number) => string) {
  const ctx = { drawImage: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
    toDataURL: vi.fn(toDataURL),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, ctx, raw: canvas };
}

const video = (w: number, h: number) => ({ videoWidth: w, videoHeight: h }) as unknown as HTMLVideoElement;

describe("evidenceSize", () => {
  it("scales the longest side down to 256 and keeps the aspect ratio", () => {
    expect(evidenceSize(1280, 720)).toEqual({ width: 256, height: 144 });
    expect(evidenceSize(480, 640)).toEqual({ width: 192, height: 256 });
  });
  it("never scales up", () => {
    expect(evidenceSize(160, 120)).toEqual({ width: 160, height: 120 });
  });
});

describe("captureEvidenceFrame", () => {
  it("draws the partner frame at 256 px and encodes JPEG at quality 0.7", () => {
    const { canvas, ctx, raw } = fakeCanvas(() => jpeg(1000));
    const v = video(1280, 720);
    expect(captureEvidenceFrame(v, canvas)).toBe(jpeg(1000));
    expect(raw.width).toBe(256);
    expect(raw.height).toBe(144);
    expect(ctx.drawImage).toHaveBeenCalledWith(v, 0, 0, 256, 144);
    expect(raw.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.7);
  });

  it("lowers the quality until the frame fits the protocol limit", () => {
    const { canvas, raw } = fakeCanvas((_t, q) => (q > 0.4 ? jpeg(LIMITS.evidenceFrameMaxChars) : jpeg(500)));
    expect(captureEvidenceFrame(video(640, 480), canvas)).toBe(jpeg(500));
    expect(raw.toDataURL.mock.calls.map((c) => c[1])).toEqual([0.7, 0.5, 0.3]);
  });

  it("returns null when even the lowest quality is too large", () => {
    const { canvas } = fakeCanvas(() => jpeg(LIMITS.evidenceFrameMaxChars));
    expect(captureEvidenceFrame(video(640, 480), canvas)).toBeNull();
  });

  it("returns null without a frame, a 2d context or a JPEG encoder", () => {
    expect(captureEvidenceFrame(null)).toBeNull();
    expect(captureEvidenceFrame(video(0, 0), fakeCanvas(() => jpeg(10)).canvas)).toBeNull();
    const noCtx = fakeCanvas(() => jpeg(10));
    noCtx.raw.getContext = vi.fn(() => null) as never;
    expect(captureEvidenceFrame(video(640, 480), noCtx.canvas)).toBeNull();
    expect(captureEvidenceFrame(video(640, 480), fakeCanvas(() => "data:,").canvas)).toBeNull();
  });

  it("returns null when the canvas throws (tainted or detached video)", () => {
    const { canvas } = fakeCanvas(() => {
      throw new DOMException("tainted", "SecurityError");
    });
    expect(captureEvidenceFrame(video(640, 480), canvas)).toBeNull();
  });
});

describe("evidenceChat", () => {
  it("keeps the last 20 lines from me and the partner, without system or failed lines", () => {
    const messages: ChatEntry[] = [
      { id: "s", from: "system", text: "friends", ts: 1 },
      { id: "f", from: "me", text: "lost", ts: 2, delivery: "failed" },
      ...Array.from({ length: 25 }, (_, i): ChatEntry => ({
        id: `m${i}`,
        from: i % 2 ? "partner" : "me",
        text: `line ${i}`,
        ts: 100 + i,
        delivery: i % 2 ? undefined : "sent",
      })),
    ];
    const lines = evidenceChat(messages);
    expect(lines).toHaveLength(LIMITS.evidenceChatLinesMax);
    expect(lines[0]).toEqual({ from: "partner", text: "line 5", ts: 105 });
    expect(lines.at(-1)).toEqual({ from: "me", text: "line 24", ts: 124 });
  });
});

describe("buildEvidence", () => {
  it("is undefined when nothing is attached", () => {
    expect(buildEvidence(null, [])).toBeUndefined();
  });
  it("includes a valid frame and the chat lines", () => {
    const chat = [{ from: "partner" as const, text: "hi", ts: 5 }];
    expect(buildEvidence(jpeg(100), chat)).toEqual({ frame: jpeg(100), chat });
  });
  it("drops a frame the server would reject", () => {
    expect(buildEvidence("data:image/png;base64,AAAA", [])).toBeUndefined();
    expect(buildEvidence(jpeg(LIMITS.evidenceFrameMaxChars), [])).toBeUndefined();
  });
});
