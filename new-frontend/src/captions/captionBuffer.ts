/**
 * The partner's caption lines as the overlay shows them: at most LINES_SHOWN,
 * an interim segment replaced in place by later segments with the same id,
 * each line gone FADE_MS after its last update.
 */
import type { CaptionSegmentPayload } from "@/lib/protocol";

export const LINES_SHOWN = 2;
export const FADE_MS = 4_000;

export interface CaptionLine {
  id: string;
  /** What the partner's browser heard. */
  text: string;
  final: boolean;
  /** Language the text is in. */
  lang: string;
  /** On-device translation into the viewer's language, once available. */
  translated: string | null;
  /** Local clock of the last update; the line fades FADE_MS later. */
  at: number;
}

export interface CaptionBufferState {
  lines: CaptionLine[];
}

export type CaptionAction =
  | { type: "segment"; segment: Omit<CaptionSegmentPayload, "roomId">; now: number }
  | { type: "translated"; id: string; text: string }
  | { type: "prune"; now: number }
  | { type: "clear" };

export const initialCaptionBuffer: CaptionBufferState = { lines: [] };

export function captionBufferReducer(state: CaptionBufferState, action: CaptionAction): CaptionBufferState {
  switch (action.type) {
    case "segment": {
      const { id, text, final, lang } = action.segment;
      const index = state.lines.findIndex((line) => line.id === id);
      if (index >= 0) {
        const line = state.lines[index]!;
        // Translation belongs to the text it was made from.
        const next: CaptionLine = { ...line, text, final, lang, translated: text === line.text ? line.translated : null, at: action.now };
        const lines = state.lines.slice();
        lines[index] = next;
        return { lines };
      }
      const lines = [...state.lines, { id, text, final, lang, translated: null, at: action.now }];
      return { lines: lines.length > LINES_SHOWN ? lines.slice(lines.length - LINES_SHOWN) : lines };
    }
    case "translated": {
      const index = state.lines.findIndex((line) => line.id === action.id);
      if (index < 0) return state;
      const lines = state.lines.slice();
      lines[index] = { ...lines[index]!, translated: action.text };
      return { lines };
    }
    case "prune": {
      const lines = state.lines.filter((line) => action.now - line.at < FADE_MS);
      return lines.length === state.lines.length ? state : { lines };
    }
    case "clear":
      return state.lines.length === 0 ? state : initialCaptionBuffer;
  }
}
