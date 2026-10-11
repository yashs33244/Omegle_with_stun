import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Signaling } from "@/hooks/useSignaling";
import type { CaptionSegmentPayload } from "@/lib/protocol";
import { CaptionsOverlay } from "./CaptionsOverlay";
import { CaptionsToggle } from "./CaptionsToggle";
import type { SpeechErrorEvent, SpeechRecognitionLike, SpeechResultEvent } from "./speech";
import { resetTranslators } from "./translator";
import { CAPTIONS_KEY, CAPTIONS_NOTICE_KEY, useCaptions } from "./useCaptions";

type Handler = (...args: unknown[]) => void;
const ROOM = "11111111-1111-4111-8111-111111111111";

/** Just enough of SpeechRecognition: the test fires results on the latest instance. */
class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: SpeechResultEvent) => void) | null = null;
  onerror: ((event: SpeechErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  aborted = 0;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started += 1;
  }
  stop() {}
  abort() {
    this.aborted += 1;
  }
  /** One result at index 0 with the given transcript. */
  result(transcript: string, isFinal: boolean) {
    const result = { isFinal, length: 1, 0: { transcript } };
    act(() => this.onresult?.({ resultIndex: 0, results: { length: 1, 0: result } }));
  }
}

function fakeSignaling() {
  const listeners = new Map<string, Set<Handler>>();
  const sent: { event: string; payload: unknown }[] = [];
  const subscribe = (event: string, handler: Handler) => {
    const set = listeners.get(event) ?? new Set<Handler>();
    set.add(handler);
    listeners.set(event, set);
    return () => {
      set.delete(handler);
    };
  };
  const send = vi.fn((event: string, payload: unknown) => {
    sent.push({ event, payload });
  });
  return {
    sent,
    subscribe: subscribe as Signaling["subscribe"],
    send: send as Signaling["send"],
    fire(segment: CaptionSegmentPayload) {
      act(() => listeners.get("caption:segment")?.forEach((h) => h(segment)));
    },
  };
}

function liveStream(): MediaStream {
  const track = { kind: "audio", readyState: "live", enabled: true } as MediaStreamTrack;
  return { getAudioTracks: () => [track] } as unknown as MediaStream;
}

interface HarnessProps {
  signaling: ReturnType<typeof fakeSignaling>;
  roomId?: string | null;
  micEnabled?: boolean;
  viewerLanguage?: string;
  partnerLanguage?: string | null;
}

const Harness: React.FC<HarnessProps> = ({ signaling, roomId = ROOM, micEnabled = true, viewerLanguage = "en", partnerLanguage = "hi" }) => {
  const captions = useCaptions({ signaling, roomId, localStream: liveStream(), micEnabled, partnerLanguage, viewerLanguage });
  return (
    <>
      <CaptionsToggle captions={captions} />
      <CaptionsOverlay captions={captions} />
    </>
  );
};

const flush = () => act(() => Promise.resolve());

beforeEach(() => {
  FakeRecognition.instances = [];
  resetTranslators();
  vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe("useCaptions", () => {
  it("the toggle is disabled with a 'needs Chrome' tooltip where SpeechRecognition is missing", () => {
    vi.unstubAllGlobals();
    render(<Harness signaling={fakeSignaling()} />);
    const toggle = screen.getByTestId("captions-toggle");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("title", "Captions need Chrome");
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it("off by default: no recogniser runs and the partner's segments are dropped", () => {
    const signaling = fakeSignaling();
    render(<Harness signaling={signaling} />);
    expect(screen.getByTestId("captions-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(FakeRecognition.instances).toHaveLength(0);
    signaling.fire({ roomId: ROOM, id: "p1", text: "hello", final: true, lang: "en" });
    expect(screen.queryByTestId("captions-overlay")).toBeNull();
  });

  it("turning captions on remembers the choice, shows the privacy notice once and starts transcribing my speech", async () => {
    const signaling = fakeSignaling();
    render(<Harness signaling={signaling} viewerLanguage="hi" />);
    fireEvent.click(screen.getByTestId("captions-toggle"));
    expect(localStorage.getItem(CAPTIONS_KEY)).toBe("1");
    expect(screen.getByTestId("captions-notice")).toHaveTextContent(
      "Your words are transcribed by your browser and sent to your partner only. Nothing is stored.",
    );
    fireEvent.click(screen.getByTestId("captions-notice-ok"));
    expect(screen.queryByTestId("captions-notice")).toBeNull();
    expect(localStorage.getItem(CAPTIONS_NOTICE_KEY)).toBe("1");

    const recognizer = FakeRecognition.instances[0]!;
    expect(recognizer.lang).toBe("hi-IN");
    expect(recognizer.continuous).toBe(true);
    expect(recognizer.interimResults).toBe(true);
    expect(recognizer.started).toBe(1);

    recognizer.result("नमस्ते", false);
    recognizer.result("नमस्ते दोस्त", true);
    expect(signaling.sent.map((s) => s.event)).toEqual(["caption:segment", "caption:segment"]);
    expect(signaling.sent[0]?.payload).toMatchObject({ roomId: ROOM, text: "नमस्ते", final: false, lang: "hi" });
    expect(signaling.sent[1]?.payload).toMatchObject({ roomId: ROOM, text: "नमस्ते दोस्त", final: true, lang: "hi" });
    const [first, second] = signaling.sent.map((s) => (s.payload as CaptionSegmentPayload).id);
    expect(first).toBe(second);

    // Off again: the recogniser is aborted and nothing more is sent.
    fireEvent.click(screen.getByTestId("captions-toggle"));
    expect(recognizer.aborted).toBe(1);
    expect(localStorage.getItem(CAPTIONS_KEY)).toBe("0");
  });

  it("does not transcribe while the mic is muted or outside a call", () => {
    localStorage.setItem(CAPTIONS_KEY, "1");
    const { rerender } = render(<Harness signaling={fakeSignaling()} micEnabled={false} />);
    expect(FakeRecognition.instances).toHaveLength(0);
    rerender(<Harness signaling={fakeSignaling()} micEnabled roomId={null} />);
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it("restarts after the browser ends a session, and stops for good on a fatal error", () => {
    vi.useFakeTimers();
    localStorage.setItem(CAPTIONS_KEY, "1");
    render(<Harness signaling={fakeSignaling()} />);
    const first = FakeRecognition.instances[0]!;
    act(() => first.onend?.());
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(FakeRecognition.instances).toHaveLength(2);
    const second = FakeRecognition.instances[1]!;
    act(() => second.onerror?.({ error: "not-allowed" }));
    act(() => second.onend?.());
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(FakeRecognition.instances).toHaveLength(2);
  });

  it("shows the partner's lines: interim replaced, final kept, translated on-device when the browser can", async () => {
    localStorage.setItem(CAPTIONS_KEY, "1");
    localStorage.setItem(CAPTIONS_NOTICE_KEY, "1");
    const translate = vi.fn(async (text: string) => `EN(${text})`);
    vi.stubGlobal("Translator", {
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => ({ translate })),
    });
    const signaling = fakeSignaling();
    render(<Harness signaling={signaling} />);
    await flush();

    signaling.fire({ roomId: ROOM, id: "p1", text: "नम", final: false, lang: "hi" });
    signaling.fire({ roomId: ROOM, id: "p1", text: "नमस्ते", final: false, lang: "hi" });
    let lines = screen.getAllByTestId("caption-line");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent("नमस्ते");
    expect(lines[0]).toHaveTextContent("original");
    expect(translate).not.toHaveBeenCalled();

    signaling.fire({ roomId: ROOM, id: "p1", text: "नमस्ते दोस्त", final: true, lang: "hi" });
    await flush();
    await flush();
    lines = screen.getAllByTestId("caption-line");
    expect(translate).toHaveBeenCalledWith("नमस्ते दोस्त");
    expect(lines[0]).toHaveAttribute("data-translated", "1");
    expect(lines[0]).toHaveTextContent("EN(नमस्ते दोस्त)");
    expect(lines[0]).not.toHaveTextContent("original");

    // Same language as the viewer: shown as is, no translator involved.
    signaling.fire({ roomId: ROOM, id: "p2", text: "see you", final: true, lang: "en" });
    await flush();
    lines = screen.getAllByTestId("caption-line");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toHaveTextContent("see you");
    expect(lines[1]).not.toHaveTextContent("original");
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("keeps the original text with a tag when the browser has no Translator", async () => {
    localStorage.setItem(CAPTIONS_KEY, "1");
    const signaling = fakeSignaling();
    render(<Harness signaling={signaling} />);
    signaling.fire({ roomId: ROOM, id: "p1", text: "नमस्ते", final: true, lang: "hi" });
    await flush();
    const line = screen.getByTestId("caption-line");
    expect(line).toHaveAttribute("data-translated", "0");
    expect(line).toHaveTextContent("नमस्ते");
    expect(line).toHaveTextContent("original");
  });

  it("lines fade out after 4 s and segments for another room are ignored", () => {
    vi.useFakeTimers();
    localStorage.setItem(CAPTIONS_KEY, "1");
    const signaling = fakeSignaling();
    render(<Harness signaling={signaling} />);
    signaling.fire({ roomId: "22222222-2222-4222-8222-222222222222", id: "x", text: "nope", final: true, lang: "en" });
    expect(screen.queryByTestId("captions-overlay")).toBeNull();
    signaling.fire({ roomId: ROOM, id: "p1", text: "hello there", final: true, lang: "en" });
    expect(screen.getByTestId("caption-line")).toHaveClass("opacity-100");
    act(() => {
      vi.advanceTimersByTime(3_500);
    });
    expect(screen.getByTestId("caption-line")).toHaveClass("opacity-0");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByTestId("captions-overlay")).toBeNull();
  });
});
