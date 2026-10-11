import { describe, expect, it } from "vitest";
import { FADE_MS, LINES_SHOWN, captionBufferReducer, initialCaptionBuffer, type CaptionBufferState } from "./captionBuffer";

const seg = (id: string, text: string, final = false, lang = "en") => ({ id, text, final, lang });

function feed(state: CaptionBufferState, segments: { seg: ReturnType<typeof seg>; now: number }[]): CaptionBufferState {
  return segments.reduce((s, { seg: segment, now }) => captionBufferReducer(s, { type: "segment", segment, now }), state);
}

describe("captionBufferReducer", () => {
  it("an interim segment is replaced in place by later segments with its id", () => {
    const state = feed(initialCaptionBuffer, [
      { seg: seg("a", "hel"), now: 1_000 },
      { seg: seg("a", "hello th"), now: 1_200 },
      { seg: seg("a", "hello there", true), now: 1_500 },
    ]);
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0]).toMatchObject({ id: "a", text: "hello there", final: true, at: 1_500 });
  });

  it("a final segment with a new id appends; only the last LINES_SHOWN stay", () => {
    const state = feed(initialCaptionBuffer, [
      { seg: seg("a", "one", true), now: 1 },
      { seg: seg("b", "two", true), now: 2 },
      { seg: seg("c", "three"), now: 3 },
    ]);
    expect(LINES_SHOWN).toBe(2);
    expect(state.lines.map((l) => l.id)).toEqual(["b", "c"]);
  });

  it("lines fade FADE_MS after their last update", () => {
    const state = feed(initialCaptionBuffer, [
      { seg: seg("a", "old", true), now: 0 },
      { seg: seg("b", "new", true), now: 2_000 },
    ]);
    const early = captionBufferReducer(state, { type: "prune", now: FADE_MS - 1 });
    expect(early).toBe(state);
    const later = captionBufferReducer(state, { type: "prune", now: FADE_MS });
    expect(later.lines.map((l) => l.id)).toEqual(["b"]);
    expect(captionBufferReducer(later, { type: "prune", now: 2_000 + FADE_MS }).lines).toEqual([]);
  });

  it("a translation attaches to its line and is dropped when the text changes", () => {
    const shown = feed(initialCaptionBuffer, [{ seg: seg("a", "hola", true, "es"), now: 0 }]);
    const translated = captionBufferReducer(shown, { type: "translated", id: "a", text: "hello" });
    expect(translated.lines[0]?.translated).toBe("hello");
    expect(captionBufferReducer(translated, { type: "translated", id: "zzz", text: "x" })).toBe(translated);
    const retext = captionBufferReducer(translated, { type: "segment", segment: seg("a", "hola amigo", true, "es"), now: 10 });
    expect(retext.lines[0]?.translated).toBeNull();
    const same = captionBufferReducer(translated, { type: "segment", segment: seg("a", "hola", true, "es"), now: 10 });
    expect(same.lines[0]?.translated).toBe("hello");
  });

  it("clear empties the buffer", () => {
    const shown = feed(initialCaptionBuffer, [{ seg: seg("a", "x"), now: 0 }]);
    expect(captionBufferReducer(shown, { type: "clear" }).lines).toEqual([]);
    expect(captionBufferReducer(initialCaptionBuffer, { type: "clear" })).toBe(initialCaptionBuffer);
  });
});
