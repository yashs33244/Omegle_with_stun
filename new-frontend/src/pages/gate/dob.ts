/**
 * Date-of-birth input checks. The client only checks that the date is real;
 * the server decides 18+ and records the outcome, never the date itself.
 */
export interface DobParts {
  day: string;
  month: string;
  year: string;
}

export type DobResult = { ok: true; iso: string } | { ok: false; error: string };

const MIN_YEAR = 1900;

export function parseDob(parts: DobParts, today: Date = new Date()): DobResult {
  const day = parts.day.trim();
  const month = parts.month.trim();
  const year = parts.year.trim();
  if (!day || !month || !year) return { ok: false, error: "Enter your full date of birth." };
  if (!/^\d{1,2}$/.test(day) || !/^\d{1,2}$/.test(month) || !/^\d{4}$/.test(year)) {
    return { ok: false, error: "Use numbers, for example 27 3 1999." };
  }
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || m > 12 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return { ok: false, error: "That date does not exist." };
  }
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  if (y < MIN_YEAR || date.getTime() > todayUtc) return { ok: false, error: "Enter your real date of birth." };
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { ok: true, iso };
}

/** "2 h 05 min", "4 min 09 s", "12 s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${pad(minutes)} min`;
  if (minutes > 0) return `${minutes} min ${pad(seconds)} s`;
  return `${seconds} s`;
}
