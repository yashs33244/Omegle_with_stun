import React, { useMemo, useState } from "react";
import type { AdminReport } from "@/lib/protocol";
import type { AdminApi } from "@/lib/adminApi";
import { ADMIN_REASON_LABELS, SEVERITY_TONE, formatSpan, nextDue, sortQueue, useAdmin, useAdminData } from "./adminShared";
import { Btn, Notice, SlaChip } from "./AdminUi";
import { ReportDetail } from "./ReportDetail";

const OPEN_STATUSES: ReadonlySet<AdminReport["status"]> = new Set(["open", "acknowledged"]);

const loadReports = (api: AdminApi) => api.listReports();

export const ReportsView: React.FC = () => {
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
            Report queue {data && <span className="text-sm font-normal text-gray-500">({queue.length})</span>}
          </h2>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
              Show closed
            </label>
            <Btn onClick={reload} disabled={loading}>
              Refresh
            </Btn>
          </div>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {loading && !data && <p className="text-sm text-gray-500">Loading...</p>}
        {data && queue.length === 0 && <p className="text-sm text-gray-500">Nothing in the queue.</p>}
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
                    <span className="font-medium">{ADMIN_REASON_LABELS[r.reason]}</span>
                    {r.restricted && (
                      <span className="rounded bg-purple-700 px-1.5 py-0.5 text-xs font-semibold text-white">Restricted</span>
                    )}
                    <span className="text-xs text-gray-500">{r.status}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-600">
                    {OPEN_STATUSES.has(r.status) && <SlaChip label={due.label} dueAt={due.dueAt} now={now} />}
                    <span>{formatSpan(now - r.createdAt)} ago</span>
                    {r.priorReportsAgainst > 0 && <span>{r.priorReportsAgainst} prior</span>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-label="Report detail" className="min-w-0">
        {selected ? (
          <ReportDetail key={selected.id} report={selected} onChanged={reload} />
        ) : (
          <p className="text-sm text-gray-500">Select a report to see the details.</p>
        )}
      </section>
    </div>
  );
};
