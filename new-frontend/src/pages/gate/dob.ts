/**
 * Date-of-birth input checks. The client only checks that the date is real;
 * the server decides 18+ and records the outcome, never the date itself.
 */
import i18n from "@/lib/i18n";

export interface DobParts {
  day: string;
  month: string;
  year: string;
}

/** `gate` namespace keys under `form.dob.errors`. */
export type DobError = "incomplete" | "notNumbers" | "notReal" | "notPlausible";

export type DobResult =
  { ok: true; iso: string } | { ok: false; error: DobError };

const MIN_YEAR = 1900;

export function parseDob(parts: DobParts, today: Date = new Date()): DobResult {
  const day = parts.day.trim();
  const month = parts.month.trim();
  const year = parts.year.trim();
  if (!day || !month || !year) return { ok: false, error: "incomplete" };
  if (
    !/^\d{1,2}$/.test(day) ||
    !/^\d{1,2}$/.test(month) ||
    !/^\d{4}$/.test(year)
  ) {
    return { ok: false, error: "notNumbers" };
  }
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    m < 1 ||
    m > 12 ||
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return { ok: false, error: "notReal" };
  }
  const todayUtc = Date.UTC(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  if (y < MIN_YEAR || date.getTime() > todayUtc)
    return { ok: false, error: "notPlausible" };
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
  if (days > 0) return i18n.t("gate:duration.days", { days, hours });
  if (hours > 0)
    return i18n.t("gate:duration.hours", { hours, minutes: pad(minutes) });
  if (minutes > 0)
    return i18n.t("gate:duration.minutes", { minutes, seconds: pad(seconds) });
  return i18n.t("gate:duration.seconds", { seconds });
}
