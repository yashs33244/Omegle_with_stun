import React, { useMemo } from "react";
import type { AdminApi } from "@/lib/adminApi";
import { formatTime, useAdminData } from "./adminShared";
import { Btn, Notice } from "./AdminUi";

const loadAudit = (api: AdminApi) => api.listAudit();

export const AuditView: React.FC = () => {
  const { data, error, loading, reload } = useAdminData(loadAudit);
  const entries = useMemo(() => [...(data ?? [])].sort((a, b) => b.ts - a.ts), [data]);
  return (
    <section aria-labelledby="audit-title" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id="audit-title" className="text-lg font-semibold">
          Audit log
        </h2>
        <Btn onClick={reload} disabled={loading}>
          Refresh
        </Btn>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {loading && !data && <p className="text-sm text-gray-500">Loading...</p>}
      {data && entries.length === 0 && <p className="text-sm text-gray-500">No entries yet.</p>}
      {entries.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
          <table className="w-full text-left text-sm" data-testid="audit-table">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th scope="col" className="px-3 py-2">
                  Time
                </th>
                <th scope="col" className="px-3 py-2">
                  Action
                </th>
                <th scope="col" className="px-3 py-2">
                  Target
                </th>
                <th scope="col" className="px-3 py-2">
                  Note
                </th>
                <th scope="col" className="px-3 py-2">
                  IP
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-gray-100 align-top">
                  <td className="whitespace-nowrap px-3 py-2">{formatTime(e.ts)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.action}</td>
                  <td className="break-all px-3 py-2 font-mono text-xs">{e.target}</td>
                  <td className="px-3 py-2 [overflow-wrap:anywhere]">{e.note ?? ""}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.ip ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
