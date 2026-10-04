import React, { useMemo, useState } from "react";
import type { AdminApi } from "@/lib/adminApi";
import type { AdminAppeal } from "@/lib/protocol";
import { formatTime, useAdmin, useAdminData } from "./adminShared";
import { Btn, Notice, SlaChip } from "./AdminUi";

const loadAppeals = (api: AdminApi) => api.listAppeals();

const AppealCard: React.FC<{ appeal: AdminAppeal; onChanged: () => void }> = ({ appeal, onChanged }) => {
  const { api, fail, now } = useAdmin();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const r = appeal.restriction;

  const decide = async (decision: "uphold" | "overturn") => {
    setBusy(true);
    setResult(null);
    try {
      await api.decideAppeal(appeal.id, decision, note.trim() || undefined);
      setResult({ tone: "ok", text: decision === "uphold" ? "Restriction upheld." : "Restriction overturned." });
      onChanged();
    } catch (err) {
      setResult({ tone: "error", text: fail(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-2 rounded-lg border border-gray-200 bg-white p-3" data-testid="appeal-item">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">
          {r.kind} for {r.reason}
        </span>
        <span className="text-gray-500">{r.until === null ? "permanent" : `until ${formatTime(r.until)}`}</span>
        <span className="text-gray-500">{appeal.status}</span>
        {appeal.status === "pending" && <SlaChip label="Decide" dueAt={appeal.dueAt} now={now} />}
      </div>
      <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{appeal.text}</p>
      <p className="text-xs text-gray-500">Received {formatTime(appeal.createdAt)}</p>
      {appeal.status === "pending" && (
        <div className="space-y-2">
          <label className="block text-sm">
            <span className="mb-1 block text-gray-600">Note to keep with the decision</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              className="w-full rounded-md border border-gray-300 p-1.5"
            />
          </label>
          <div className="flex gap-2">
            <Btn disabled={busy} onClick={() => void decide("uphold")}>
              Uphold
            </Btn>
            <Btn tone="primary" disabled={busy} onClick={() => void decide("overturn")}>
              Overturn
            </Btn>
          </div>
        </div>
      )}
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
    </li>
  );
};

export const AppealsView: React.FC = () => {
  const { data, error, loading, reload } = useAdminData(loadAppeals);
  const appeals = useMemo(
    () =>
      [...(data ?? [])].sort(
        (a, b) => Number(b.status === "pending") - Number(a.status === "pending") || a.dueAt - b.dueAt,
      ),
    [data],
  );
  return (
    <section aria-labelledby="appeals-title" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id="appeals-title" className="text-lg font-semibold">
          Appeals
        </h2>
        <Btn onClick={reload} disabled={loading}>
          Refresh
        </Btn>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {loading && !data && <p className="text-sm text-gray-500">Loading...</p>}
      {data && appeals.length === 0 && <p className="text-sm text-gray-500">No appeals.</p>}
      <ul className="space-y-2">
        {appeals.map((a) => (
          <AppealCard key={a.id} appeal={a} onChanged={reload} />
        ))}
      </ul>
    </section>
  );
};
