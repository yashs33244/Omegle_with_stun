/**
 * Pure matching rules between two waiting users. Blocks and bans live in the
 * store and are checked by MatchService on top of this.
 */
import type { Preferences, Profile } from "../protocol";

export interface Candidate {
  deviceId: string;
  profile: Pick<Profile, "gender" | "language" | "topics">;
  preferences: Preferences;
}

/** "en-US" -> "en". Language filters compare primary subtags, case-insensitively. */
export function primaryLanguage(code: string): string {
  return code.split("-")[0]!.toLowerCase();
}

/** Does `a` accept `b` as a partner (one direction only)? */
function accepts(a: Candidate, b: Candidate): boolean {
  const { genderFilter, languageFilter } = a.preferences;
  // Filters never include "unspecified", so an unspecified gender only meets "all".
  if (genderFilter !== "all" && genderFilter !== b.profile.gender) return false;
  if (
    languageFilter !== "any" &&
    languageFilter !== b.profile.language &&
    primaryLanguage(languageFilter) !== primaryLanguage(b.profile.language)
  ) {
    return false;
  }
  return true;
}

export function isCompatible(a: Candidate, b: Candidate): boolean {
  if (a.deviceId === b.deviceId) return false;
  if (!a.profile.topics.some((t) => b.profile.topics.includes(t))) return false;
  return accepts(a, b) && accepts(b, a);
}
