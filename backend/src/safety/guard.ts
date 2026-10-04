/**
 * Server-side chat and name guard (LAUNCH_PLAN LB-10, D3, LB-7).
 *
 * Chat: during the first minutes of a call, URLs, social handles and phone
 * numbers are replaced with "[hidden for safety]". Contact-sharing attempts
 * and solicitation phrases (EN, HI, Hinglish) raise informative nudges; the
 * guard never blocks a message and never penalizes on its own.
 *
 * Names: the same detector plus a short slur list. A rejected name becomes a
 * stable generated nickname ("Stranger 4821").
 *
 * It cannot catch a handle written on paper or spelled out creatively; the
 * report reasons cover that.
 */
import { createHash } from "node:crypto";
import {
  ALWAYS_CONTACT_PLATFORMS,
  CONTACT_PHRASES,
  HANDLE_CONNECTORS,
  NAME_SLURS,
  NOT_HANDLES,
  SOCIAL_HOSTS,
  SOLICITATION_PHRASES,
  STRONG_PLATFORMS,
  WEAK_PLATFORMS,
} from "./phrases";

export const HIDDEN = "[hidden for safety]";

/* ------------------------------------------------------------------ */
/* Normalization for phrase matching                                   */
/* ------------------------------------------------------------------ */

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

/**
 * Lowercase, NFKC, common leetspeak, punctuation to spaces, repeated letters
 * collapsed ("shoooow" -> "show", "boobs" -> "bobs"), padded with spaces so
 * whole-word phrases match with includes(" phrase ").
 */
export function normalize(text: string): string {
  const s = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[013457@$]/g, (ch) => LEET[ch] ?? ch)
    .replace(/'/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .replace(/(.)\1+/gu, "$1")
    .trim();
  return ` ${s} `;
}

const normalizeAll = (list: readonly string[]) => [...new Set(list.map((p) => normalize(p)))];
const SOLICITATION = normalizeAll(SOLICITATION_PHRASES);
const CONTACT = normalizeAll(CONTACT_PHRASES);

function hasPhrase(normalized: string, phrases: string[]): boolean {
  return phrases.some((p) => normalized.includes(p));
}

/* ------------------------------------------------------------------ */
/* Span detection on the raw text                                      */
/* ------------------------------------------------------------------ */

interface Span {
  start: number;
  end: number;
  /** contact: handles, phones, messaging apps, social links. link: other URLs. */
  kind: "contact" | "link";
}

const TLDS =
  "com|net|org|in|io|me|co|gg|app|ly|xyz|link|tv|site|online|info|biz|us|uk|ru|cc|to|be|dev|ai|live|fun|club|store|shop|page|bio";
const URL_RE = new RegExp(
  String.raw`(?:\bhttps?:\/\/|\bwww\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:${TLDS})\b(?:\/\S*)?`,
  "gi",
);
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/gi;
const AT_HANDLE_RE = /(?<![\w@])@[a-z0-9_.]{2,30}/gi;
const PHONE_RE = /\+?[\d०-९][\d०-९\s().-]{5,}[\d०-९]/g;
const TOKEN_RE = /[\p{L}\p{M}\p{N}_.@']+|[:=-]/gu;

const ALWAYS = new Set<string>(ALWAYS_CONTACT_PLATFORMS);
const STRONG = new Set<string>(STRONG_PLATFORMS);
const WEAK = new Set<string>(WEAK_PLATFORMS);
const CONNECTORS = new Set<string>(HANDLE_CONNECTORS);
const NOT_HANDLE = new Set<string>(NOT_HANDLES);

function isPlatform(word: string): boolean {
  return ALWAYS.has(word) || STRONG.has(word) || WEAK.has(word);
}

function urlSpans(text: string, spans: Span[]): void {
  for (const m of text.matchAll(EMAIL_RE)) spans.push({ start: m.index, end: m.index + m[0].length, kind: "contact" });
  for (const m of text.matchAll(URL_RE)) {
    const lower = m[0].toLowerCase();
    const social = SOCIAL_HOSTS.some((h) => new RegExp(String.raw`(^|[/.])${h.replace(/\./g, "\\.")}(\/|$|\?)`).test(lower));
    spans.push({ start: m.index, end: m.index + m[0].length, kind: social ? "contact" : "link" });
  }
}

function phoneSpans(text: string, spans: Span[]): void {
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/[^\d०-९]/g, "").length;
    if (digits >= 7 && digits <= 15) spans.push({ start: m.index, end: m.index + m[0].length, kind: "contact" });
  }
}

/** "snap: priya", "insta priya_k", "my ig is @x", "add me on whatsapp". */
function platformSpans(text: string, spans: Span[]): void {
  const tokens = [...text.matchAll(TOKEN_RE)].map((m) => ({
    start: m.index,
    end: m.index + m[0].replace(/\.+$/, "").length,
    word: m[0].replace(/\.+$/, "").replace(/^@/, "").toLowerCase(),
    raw: m[0],
  }));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!isPlatform(t.word)) continue;
    let j = i + 1;
    let explicit = false;
    while (j < tokens.length && j <= i + 3) {
      const w = tokens[j]!.word;
      if (w === ":" || w === "=" || w === "-") explicit = true;
      else if (!CONNECTORS.has(w)) break;
      j++;
    }
    const cand = tokens[j];
    let end = -1;
    if (cand && /^@?[\p{L}\p{N}_.]{2,30}$/u.test(cand.raw.replace(/\.+$/, "")) && !NOT_HANDLE.has(cand.word) && !isPlatform(cand.word)) {
      const weakOk = explicit || cand.raw.startsWith("@") || /[\d_.]/.test(cand.word);
      if (!WEAK.has(t.word) || weakOk) end = cand.end;
    }
    if (end >= 0) spans.push({ start: t.start, end, kind: "contact" });
    else if (ALWAYS.has(t.word)) spans.push({ start: t.start, end: t.end, kind: "contact" });
  }
}

function findSpans(text: string): Span[] {
  const spans: Span[] = [];
  urlSpans(text, spans);
  for (const m of text.matchAll(AT_HANDLE_RE)) spans.push({ start: m.index, end: m.index + m[0].length, kind: "contact" });
  phoneSpans(text, spans);
  platformSpans(text, spans);
  return spans;
}

/** Replaces each merged span with HIDDEN. */
function redact(text: string, spans: Span[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  let open: { start: number; end: number } | null = null;
  for (const s of sorted) {
    if (open && s.start <= open.end) {
      open.end = Math.max(open.end, s.end);
      continue;
    }
    if (open) {
      out += text.slice(cursor, open.start) + HIDDEN;
      cursor = open.end;
    }
    open = { start: s.start, end: s.end };
  }
  if (open) {
    out += text.slice(cursor, open.start) + HIDDEN;
    cursor = open.end;
  }
  return out + text.slice(cursor);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface ChatGuardResult {
  text: string;
  /** Links, handles or phone numbers were replaced. */
  redacted: boolean;
  /** A handle, phone number, messaging app or "add me on ..." showed up. */
  contactSharing: boolean;
  solicitation: boolean;
}

/** `redact` is true during the guarded part of a call (the first 2 minutes). */
export function guardChat(text: string, opts: { redact: boolean }): ChatGuardResult {
  const spans = findSpans(text);
  const normalized = normalize(text);
  const contactSharing = spans.some((s) => s.kind === "contact") || hasPhrase(normalized, CONTACT);
  const solicitation = hasPhrase(normalized, SOLICITATION);
  if (!opts.redact || spans.length === 0) return { text, redacted: false, contactSharing, solicitation };
  return { text: redact(text, spans), redacted: true, contactSharing, solicitation };
}

const SLURS = NAME_SLURS.map((s) => normalize(s).trim());
/** Slurs that are also substrings of ordinary words; matched as whole words only. */
const WORD_ONLY = new Set(["rapist", "chamar"].map((s) => normalize(s).trim()));

export function containsSlur(text: string): boolean {
  const normalized = normalize(text);
  const squashed = normalized.replace(/\s+/g, "");
  return SLURS.some((s) => normalized.includes(` ${s} `) || (s.length >= 5 && !WORD_ONLY.has(s) && squashed.includes(s)));
}

/** Stable per device, so a rejected name does not change on every hello. */
export function nicknameFor(deviceId: string): string {
  const n = createHash("sha256").update(`chizzy-nick:${deviceId}`).digest().readUInt32BE(0);
  return `Stranger ${1000 + (n % 9000)}`;
}

/** Display-name guard: contact details or a slur -> generated nickname. */
export function guardName(name: string, deviceId: string): { name: string; replaced: boolean } {
  if (findSpans(name).length > 0 || containsSlur(name)) return { name: nicknameFor(deviceId), replaced: true };
  return { name, replaced: false };
}
