import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RESTRICTION_REASONS, type AdminReport, type AdminReportAction, type RestrictionReason } from "@/lib/protocol";
import { AdminApiError, type EvidenceImage } from "@/lib/adminApi";
import { watermarkCode } from "@/components/safety/watermarkCode";
import {
  ADMIN_REASON_KEYS,
  DURATION_PRESETS,
  RESTRICTION_FOR_REPORT,
  SEVERITY_TONE,
  downloadJson,
  formatTime,
  useAdmin,
} from "./adminShared";
import { Btn, ConfirmDialog, Notice, SlaChip } from "./AdminUi";

interface ReportDetailProps {
  report: AdminReport;
  onChanged: () => void;
}

type Confirm = { kind: "permanent" } | { kind: "csam" } | null;

/** Evidence frame: blurred and greyscale until the reviewer explicitly unblurs it. Never loaded for restricted items. */
const Evidence: React.FC<{ report: AdminReport }> = ({ report }) => {
  const { t } = useTranslation("admin");
  const { api, fail } = useAdmin();
  const [image, setImage] = useState<EvidenceImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blurred, setBlurred] = useState(true);
  const canLoad = report.hasFrame && !report.restricted;

  useEffect(() => {
    if (!canLoad) return;
    let current: EvidenceImage | null = null;
    let cancelled = false;
    api
      .getReportFrame(report.id)
      .then((img) => {
        if (cancelled) {
          img?.revoke();
          return;
        }
        current = img;
        setImage(img);
        if (!img) setError(t("detail.noImageReturned"));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(fail(err));
      });
    return () => {
      cancelled = true;
      current?.revoke();
    };
  }, [api, fail, report.id, canLoad, t]);

  if (report.restricted) {
    return (
      <p className="rounded-md bg-purple-50 p-3 text-sm text-purple-900" data-testid="evidence-restricted">
        {t("detail.restrictedEvidence")}
      </p>
    );
  }
  if (!report.hasFrame) return <p className="text-sm text-gray-500">{t("detail.noImage")}</p>;
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!image) return <p className="text-sm text-gray-500">{t("detail.imageLoading")}</p>;

  return (
    <div className="space-y-2">
      <div className="inline-block overflow-hidden rounded-md border border-gray-300 bg-gray-200">
        <img
          src={image.src}
          alt={blurred ? t("detail.altBlurred") : t("detail.alt")}
          data-testid="evidence-image"
          data-blurred={blurred ? "true" : "false"}
          className="block max-h-64 max-w-full"
          style={{ filter: blurred ? "blur(16px) grayscale(1)" : "none" }}
        />
      </div>
      <div>
        <Btn onClick={() => setBlurred((b) => !b)} aria-pressed={!blurred}>
          {blurred ? t("detail.unblur") : t("detail.blurAgain")}
        </Btn>
      </div>
    </div>
  );
};

export const ReportDetail: React.FC<ReportDetailProps> = ({ report, onChanged }) => {
  const { t } = useTranslation("admin");
  const { api, fail, now } = useAdmin();
  const [note, setNote] = useState("");
  const [restrictReason, setRestrictReason] = useState<RestrictionReason>(RESTRICTION_FOR_REPORT[report.reason]);
  const [durationIndex, setDurationIndex] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const closed = report.status === "dismissed" || report.status === "actioned" || report.status === "escalated";
  const duration = DURATION_PRESETS[durationIndex]!;

  const run = async (action: AdminReportAction, done: string) => {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.actOnReport(report.id, { ...action, ...(note.trim() ? { note: note.trim() } : {}) });
      if (action.action === "escalate_csam") {
        if (!res.packet) throw new AdminApiError(500, t("errors.noPacket"));
        downloadJson(`csam-packet-${report.id}.json`, res.packet);
      }
      setResult({ tone: "ok", text: done });
      setNote("");
      onChanged();
    } catch (err) {
      setResult({ tone: "error", text: fail(err) });
    } finally {
      setBusy(false);
    }
  };

  const restrict = () => {
    if (duration.ms === null) {
      setConfirm({ kind: "permanent" });
      return;
    }
    void run({ action: "restrict", reason: restrictReason, durationMs: duration.ms }, t("detail.restrictedFor", { duration: t(duration.key) }));
  };

  return (
    <article className="space-y-4 rounded-lg border border-gray-200 bg-white p-4" data-testid="report-detail">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase ${SEVERITY_TONE[report.severity]}`}>
            {report.severity}
          </span>
          <h2 className="text-lg font-semibold">{t(ADMIN_REASON_KEYS[report.reason])}</h2>
          <span className="text-sm text-gray-500">{report.status}</span>
        </div>
        {!closed && (
          <div className="flex flex-wrap gap-2">
            {report.status === "open" && <SlaChip label={t("detail.acknowledgeChip")} dueAt={report.ackDueAt} now={now} />}
            <SlaChip label={t("detail.resolveChip")} dueAt={report.resolveDueAt} now={now} />
          </div>
        )}
      </header>

      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-500">{t("detail.received")}</dt>
        <dd>{formatTime(report.createdAt)}</dd>
        <dt className="text-gray-500">{t("detail.watermark")}</dt>
        <dd className="font-mono" data-testid="detail-watermark">
          {watermarkCode(report.roomId)}
        </dd>
        <dt className="text-gray-500">{t("detail.reportedDevice")}</dt>
        <dd className="break-all font-mono text-xs">{report.reported}</dd>
        <dt className="text-gray-500">{t("detail.priorAgainst")}</dt>
        <dd>{report.priorReportsAgainst}</dd>
        <dt className="text-gray-500">{t("detail.reporter")}</dt>
        <dd className="break-all">
          <span className="font-mono text-xs">{report.reporter}</span>{" "}
          {t("detail.reporterWeight", { weight: report.reporterWeight.toFixed(2) })}
        </dd>
        <dt className="text-gray-500">{t("detail.classifierScore")}</dt>
        <dd data-testid="detail-score">{report.nsfwScore === null ? t("detail.notAvailable") : report.nsfwScore.toFixed(2)}</dd>
        <dt className="text-gray-500">{t("detail.details")}</dt>
        <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{report.details ?? t("detail.none")}</dd>
      </dl>

      <section aria-labelledby="evidence-title" className="space-y-2">
        <h3 id="evidence-title" className="font-semibold">
          {t("detail.evidenceTitle")} <span className="text-xs font-normal text-gray-500">{t("detail.evidenceHint")}</span>
        </h3>
        <Evidence report={report} />
      </section>

      <section aria-labelledby="chat-title" className="space-y-2">
        <h3 id="chat-title" className="font-semibold">
          {t("detail.chatTitle", { count: report.chat.length })}
        </h3>
        {report.chat.length === 0 ? (
          <p className="text-sm text-gray-500">{t("detail.noChat")}</p>
        ) : (
          <ol className="space-y-1 text-sm" data-testid="detail-chat">
            {report.chat.map((line, i) => (
              <li key={i} className="[overflow-wrap:anywhere]">
                <span className={`font-semibold ${line.from === "reported" ? "text-red-700" : "text-gray-700"}`}>
                  {line.from === "reported" ? t("detail.chatReported") : t("detail.chatReporter")}
                </span>{" "}
                {line.text}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="actions-title" className="space-y-3 border-t border-gray-200 pt-3">
        <h3 id="actions-title" className="font-semibold">
          {t("detail.actionsTitle")}
        </h3>
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600">{t("detail.noteLabel")}</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={2}
            className="w-full rounded-md border border-gray-300 p-2"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {report.status === "open" && (
            <Btn disabled={busy} onClick={() => void run({ action: "acknowledge" }, t("detail.acknowledged"))}>
              {t("detail.acknowledge")}
            </Btn>
          )}
          <Btn disabled={busy} onClick={() => void run({ action: "dismiss" }, t("detail.dismissed"))}>
            {t("detail.dismiss")}
          </Btn>
          <Btn
            disabled={busy}
            onClick={() => void run({ action: "warn", reason: restrictReason }, t("detail.warningSent"))}
          >
            {t("detail.warn")}
          </Btn>
        </div>
        <fieldset className="flex flex-wrap items-end gap-2 rounded-md border border-gray-200 p-3">
          <legend className="px-1 text-sm font-medium">{t("detail.restrictLegend")}</legend>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">{t("detail.reasonLabel")}</span>
            <select
              value={restrictReason}
              onChange={(e) => setRestrictReason(e.target.value as RestrictionReason)}
              className="rounded-md border border-gray-300 p-1.5"
            >
              {RESTRICTION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">{t("detail.durationLabel")}</span>
            <select
              value={durationIndex}
              onChange={(e) => setDurationIndex(Number(e.target.value))}
              className="rounded-md border border-gray-300 p-1.5"
            >
              {DURATION_PRESETS.map((d, i) => (
                <option key={d.key} value={i}>
                  {t(d.key)}
                </option>
              ))}
            </select>
          </label>
          <Btn tone="primary" disabled={busy} onClick={restrict}>
            {t("detail.restrict")}
          </Btn>
        </fieldset>
        <div>
          <Btn tone="danger" disabled={busy} onClick={() => setConfirm({ kind: "csam" })}>
            {t("detail.escalateCsam")}
          </Btn>
        </div>
        {result && <Notice tone={result.tone}>{result.text}</Notice>}
      </section>

      <ConfirmDialog
        open={confirm?.kind === "permanent"}
        title={t("detail.permanentTitle")}
        description={<p>{t("detail.permanentBody")}</p>}
        confirmLabel={t("detail.permanentConfirm")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void run({ action: "restrict", reason: restrictReason, durationMs: null }, t("detail.restrictedPermanently"));
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "csam"}
        title={t("detail.csamTitle")}
        description={
          <>
            <p>{t("detail.csamBody1")}</p>
            <p>{t("detail.csamBody2")}</p>
          </>
        }
        confirmLabel={t("detail.csamConfirm")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void run({ action: "escalate_csam" }, t("detail.escalated"));
        }}
      />
    </article>
  );
};
