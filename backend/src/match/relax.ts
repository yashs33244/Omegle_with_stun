/**
 * Relaxation ladder (LAUNCH_PLAN LB-9, BUILD_V1 item 4). Pure functions.
 *
 *   step 0 (0-5 s)   shared topic AND same language
 *   step 1 (5-10 s)  same language
 *   step 2 (10 s+)   anyone who passes the hard rules (compatibility.ts)
 *
 * "Same language" is the soft preference for two users without a language
 * filter. When either side set a language FILTER, that filter (a hard rule) is
 * what decides, so the soft check is skipped.
 *
 * A pair uses the more relaxed of its two steps: someone who has waited 12 s
 * accepts anyone, so a newcomer is matched with them at once.
 *
 * Low-priority devices (risk score, early skips) wait `lowPriorityDelayMs`
 * longer before they can be matched at all (step HELD) and climb the ladder
 * that much later. Nobody is ever excluded for good.
 */
import { primaryLanguage, type Candidate } from "./compatibility";

export const HELD = -1;
export const MAX_STEP = 2;

export interface Ladder {
  relaxTopicsAfterMs: number;
  relaxLanguageAfterMs: number;
  lowPriorityDelayMs: number;
}

/** The ladder step after waiting `waitedMs`, or HELD while a low-priority device is held back. */
export function relaxStep(waitedMs: number, ladder: Ladder, lowPriority = false): number {
  const effective = waitedMs - (lowPriority ? ladder.lowPriorityDelayMs : 0);
  if (effective < 0) return HELD;
  if (effective < ladder.relaxTopicsAfterMs) return 0;
  if (effective < ladder.relaxLanguageAfterMs) return 1;
  return MAX_STEP;
}

/** Soft preferences for a pair at `step` (the more relaxed step of the two). */
export function meetsPreferences(a: Candidate, b: Candidate, step: number): boolean {
  if (step === HELD) return false;
  if (step >= MAX_STEP) return true;
  const filtered = a.preferences.languageFilter !== "any" || b.preferences.languageFilter !== "any";
  if (!filtered && primaryLanguage(a.profile.language) !== primaryLanguage(b.profile.language)) return false;
  if (step === 0 && !a.profile.topics.some((t) => b.profile.topics.includes(t))) return false;
  return true;
}

/** The step a pair is judged at: HELD if either side is held, else the more relaxed one. */
export function pairStep(stepA: number, stepB: number): number {
  return stepA === HELD || stepB === HELD ? HELD : Math.max(stepA, stepB);
}
