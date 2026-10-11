import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AdminReport } from "@/lib/protocol";
import type { AdminApi } from "@/lib/adminApi";
import { ADMIN_REASON_KEYS, SEVERITY_TONE, formatSpan, nextDue, sortQueue, useAdmin, useAdminData } from "./adminShared";
import { Btn, Notice, SlaChip } from "./AdminUi";
import { ReportDetail } from "./ReportDetail";

const OPEN_STATUSES: ReadonlySet<AdminReport["status"]> = new Set(["open", "acknowledged"]);

const loadReports = (api: AdminApi) => api.listReports();

export const ReportsView: React.FC = () => {
  const { t } = useTranslation("admin");
  const { now } = useAdmin();
  const { data, error, loading, reload } = useAdminData(loadReports);
  const [showClosed, setShowClosed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const queue = useMemo(
    () => sortQueue((data ?? []).filter((r) => showClosed || OPEN_STATUSES.has(r.status))),
    [data, showClosed],
  );
  const selected = data?.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <section aria-labelledby="queue-title" className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="queue-title" className="text-lg font-semibold">
            {t("reports.title")}{" "}
            {data && <span className="text-sm font-normal text-gray-500">{t("reports.count", { count: queue.length })}</span>}
          </h2>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
              {t("reports.showClosed")}
            </label>
            <Btn onClick={reload} disabled={loading}>
              {t("ui.refresh")}
            </Btn>
          </div>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {loading && !data && <p className="text-sm text-gray-500">{t("loading", { ns: "common" })}</p>}
        {data && queue.length === 0 && <p className="text-sm text-gray-500">{t("reports.empty")}</p>}
        <ul className="space-y-2" data-testid="report-queue">
          {queue.map((r) => {
            const due = nextDue(r);
            const active = r.id === selectedId;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  aria-current={active ? "true" : undefined}
                  data-testid="queue-item"
                  data-severity={r.severity}
                  className={`w-full rounded-lg border p-3 text-left focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    active ? "border-blue-500 bg-blue-50" : "border-gray-200 bg-white hover:bg-gray-50"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase ${SEVERITY_TONE[r.severity]}`}>
                      {r.severity}
                    </span>
                    <span className="font-medium">{t(ADMIN_REASON_KEYS[r.reason])}</span>
                    {r.restricted && (
                      <span className="rounded bg-purple-700 px-1.5 py-0.5 text-xs font-semibold text-white">{t("reports.restricted")}</span>
                    )}
                    <span className="text-xs text-gray-500">{r.status}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-600">
                    {OPEN_STATUSES.has(r.status) && <SlaChip label={t(due.labelKey)} dueAt={due.dueAt} now={now} />}
                    <span>{t("reports.ago", { span: formatSpan(now - r.createdAt) })}</span>
                    {r.priorReportsAgainst > 0 && <span>{t("reports.prior", { count: r.priorReportsAgainst })}</span>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-label={t("reports.detailAria")} className="min-w-0">
        {selected ? (
          <ReportDetail key={selected.id} report={selected} onChanged={reload} />
        ) : (
          <p className="text-sm text-gray-500">{t("reports.selectPrompt")}</p>
        )}
      </section>
    </div>
  );
};
