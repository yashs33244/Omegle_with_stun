import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { AdminApi } from "@/lib/adminApi";
import { AdminApiError } from "@/lib/adminApi";
import i18n from "@/lib/i18n";
import type { AdminReport, ReportReason, RestrictionReason, Severity } from "@/lib/protocol";

export interface AdminContextValue {
  api: AdminApi;
  /** Turns an error into a message; a rejected token signs the console out. */
  fail: (err: unknown) => string;
  /** Ticks every 30 s for SLA countdowns. */
  now: number;
}

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error("useAdmin outside the admin console");
  return ctx;
}

export function errorText(err: unknown): string {
  if (err instanceof AdminApiError) {
    return err.status ? i18n.t("admin:errors.withStatus", { message: err.message, status: err.status }) : err.message;
  }
  return err instanceof Error ? err.message : i18n.t("admin:errors.generic");
}

/** Loads data through the admin API with loading, error and reload. */
export function useAdminData<T>(load: (api: AdminApi) => Promise<T>) {
  const { api, fail } = useAdmin();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load(api)
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(fail(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `load` is a module-level function in every caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, fail, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, loading, reload };
}

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const SEVERITY_TONE: Record<Severity, string> = {
  critical: "bg-red-700 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-yellow-300 text-yellow-950",
  low: "bg-gray-200 text-gray-800",
};

export const ADMIN_REASON_KEYS = {
  underage: "reasons.underage",
  nudity: "reasons.nudity",
  harassment: "reasons.harassment",
  hate: "reasons.hate",
  violence: "reasons.violence",
  spam: "reasons.spam",
  fake: "reasons.fake",
  inappropriate: "reasons.inappropriate",
  other: "reasons.other",
} as const satisfies Record<ReportReason, string>;

/** Default restriction reason for a report reason. */
export const RESTRICTION_FOR_REPORT: Record<ReportReason, RestrictionReason> = {
  underage: "underage",
  nudity: "nudity",
  harassment: "harassment",
  hate: "hate",
  violence: "violence",
  spam: "spam",
  fake: "fake-video",
  inappropriate: "other",
  other: "other",
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "45 min", "3 h 20 min", "4 d 2 h". */
export function formatSpan(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < HOUR) return i18n.t("admin:span.min", { n: Math.max(1, Math.round(abs / MIN)) });
  if (abs < 2 * DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs % HOUR) / MIN);
    return m ? i18n.t("admin:span.hm", { h, m }) : i18n.t("admin:span.h", { h });
  }
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  return h ? i18n.t("admin:span.dh", { d, h }) : i18n.t("admin:span.d", { d });
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export const DURATION_PRESETS = [
  { key: "durations.tenMin", ms: 10 * MIN },
  { key: "durations.day", ms: DAY },
  { key: "durations.week", ms: 7 * DAY },
  { key: "durations.permanent", ms: null },
] as const satisfies ReadonlyArray<{ key: string; ms: number | null }>;

export function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The deadline that matters now: acknowledge while open, then resolve. */
export function nextDue(r: AdminReport): { labelKey: "due.ack" | "due.resolve"; dueAt: number } {
  return r.status === "open" ? { labelKey: "due.ack", dueAt: r.ackDueAt } : { labelKey: "due.resolve", dueAt: r.resolveDueAt };
}

/** Severity first (minor > nudity > harassment > spam > other, as ranked by the server), then the nearest deadline. */
export function sortQueue(reports: readonly AdminReport[]): AdminReport[] {
  return [...reports].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || nextDue(a).dueAt - nextDue(b).dueAt,
  );
}
