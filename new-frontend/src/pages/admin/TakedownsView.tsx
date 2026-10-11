import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AdminApi } from "@/lib/adminApi";
import type { AdminTakedown } from "@/lib/protocol";
import { formatTime, useAdmin, useAdminData } from "./adminShared";
import { Btn, Notice, SlaChip } from "./AdminUi";

const loadTakedowns = (api: AdminApi) => api.listTakedowns();

const KIND_KEYS = {
  ncii: "takedowns.kinds.ncii",
  csam: "takedowns.kinds.csam",
  impersonation: "takedowns.kinds.impersonation",
  other: "takedowns.kinds.other",
} as const satisfies Record<AdminTakedown["kind"], string>;

const TakedownCard: React.FC<{ ticket: AdminTakedown; onChanged: () => void }> = ({ ticket, onChanged }) => {
  const { t } = useTranslation("admin");
  const { api, fail, now } = useAdmin();
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const resolve = async () => {
    setBusy(true);
    setResult(null);
    try {
      await api.resolveTakedown(ticket.id, resolution.trim());
      setResult({ tone: "ok", text: t("takedowns.resolved") });
      onChanged();
    } catch (err) {
      setResult({ tone: "error", text: fail(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-2 rounded-lg border border-gray-200 bg-white p-3" data-testid="takedown-item">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{t(KIND_KEYS[ticket.kind])}</span>
        <span className="text-gray-500">{ticket.status}</span>
        {ticket.status === "open" && <SlaChip label={t("takedowns.removeBy")} dueAt={ticket.dueAt} now={now} />}
      </div>
      <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{ticket.description}</p>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 text-xs text-gray-600">
        <dt>{t("takedowns.contact")}</dt>
        <dd className="break-all">{ticket.contactEmail}</dd>
        <dt>{t("takedowns.where")}</dt>
        <dd className="[overflow-wrap:anywhere]">{ticket.location ?? t("takedowns.notGiven")}</dd>
        <dt>{t("takedowns.affectedPerson")}</dt>
        <dd>{ticket.isAffectedPerson ? t("takedowns.yes") : t("takedowns.onBehalf")}</dd>
        <dt>{t("takedowns.received")}</dt>
        <dd>{formatTime(ticket.createdAt)}</dd>
      </dl>
      {ticket.status === "resolved" ? (
        <p className="text-sm">{t("takedowns.resolution", { resolution: ticket.resolution })}</p>
      ) : (
        <div className="space-y-2">
          <label className="block text-sm">
            <span className="mb-1 block text-gray-600">{t("takedowns.resolutionLabel")}</span>
            <textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              maxLength={2000}
              rows={2}
              className="w-full rounded-md border border-gray-300 p-1.5"
            />
          </label>
          <Btn tone="primary" disabled={busy || !resolution.trim()} onClick={() => void resolve()}>
            {t("takedowns.resolve")}
          </Btn>
        </div>
      )}
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
    </li>
  );
};

export const TakedownsView: React.FC = () => {
  const { t } = useTranslation("admin");
  const { data, error, loading, reload } = useAdminData(loadTakedowns);
  const tickets = useMemo(
    () => [...(data ?? [])].sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || a.dueAt - b.dueAt),
    [data],
  );
  return (
    <section aria-labelledby="takedowns-title" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id="takedowns-title" className="text-lg font-semibold">
          {t("takedowns.title")}
        </h2>
        <Btn onClick={reload} disabled={loading}>
          {t("ui.refresh")}
        </Btn>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {loading && !data && <p className="text-sm text-gray-500">{t("loading", { ns: "common" })}</p>}
      {data && tickets.length === 0 && <p className="text-sm text-gray-500">{t("takedowns.empty")}</p>}
      <ul className="space-y-2">
        {tickets.map((ticket) => (
          <TakedownCard key={ticket.id} ticket={ticket} onChanged={reload} />
        ))}
      </ul>
    </section>
  );
};
