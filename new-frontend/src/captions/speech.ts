/**
 * Web Speech API feature detection. TypeScript's DOM lib has no types for
 * SpeechRecognition, so the minimal surface we use is declared here.
 *
 * Support (by detection, not by claims): Chrome and Edge expose
 * `webkitSpeechRecognition` (desktop and Android); Safari 14.1+ exposes
 * `webkitSpeechRecognition` too; Firefox exposes neither.
 */
export interface SpeechResultAlternative {
  transcript: string;
}

export interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechResultAlternative;
}

export interface SpeechResultEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechResult };
}

export interface SpeechErrorEvent {
  readonly error: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechGlobals {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

/** The recogniser constructor, or null where the browser has none (Firefox). */
export function speechRecognition(): SpeechRecognitionCtor | null {
  const g = globalThis as SpeechGlobals;
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

/**
 * BCP 47 tag the recogniser runs in, from the profile's "I speak" code.
 * Regional variants recognise better than bare codes; unknown codes pass through.
 */
const SPEECH_TAGS: Record<string, string> = {
  en: "en-IN",
  hi: "hi-IN",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-BR",
  ru: "ru-RU",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN",
  ar: "ar-SA",
};

export function speechTag(language: string): string {
  return SPEECH_TAGS[language] ?? language;
}
