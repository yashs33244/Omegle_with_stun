/**
 * Age from a date of birth, computed in UTC. The date of birth is only ever
 * held in memory for this calculation: never stored, never logged.
 */

/** Parses "YYYY-MM-DD" as a real calendar date (rejects 2023-02-30). */
function parseIsoDate(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return { y, m, d };
}

/**
 * Whole years between the date of birth and `now` (epoch ms), in UTC.
 * Returns null for malformed dates, dates in the future and dates before 1900.
 * Someone born on 29 February turns a year older on 1 March in common years.
 */
export function ageInYears(dob: string, now: number): number | null {
  const parsed = parseIsoDate(dob);
  if (!parsed || parsed.y < 1900) return null;
  if (Date.UTC(parsed.y, parsed.m - 1, parsed.d) > now) return null;
  const today = new Date(now);
  const month = today.getUTCMonth() + 1;
  const day = today.getUTCDate();
  let age = today.getUTCFullYear() - parsed.y;
  if (month < parsed.m || (month === parsed.m && day < parsed.d)) age -= 1;
  return age;
}

export const ADULT_AGE = 18;
