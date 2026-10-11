import React, { useEffect, useState } from "react";
import { RESTRICTION_REASONS, type AdminReport, type AdminReportAction, type RestrictionReason } from "@/lib/protocol";
import { AdminApiError, type EvidenceImage } from "@/lib/adminApi";
import { watermarkCode } from "@/components/safety/watermarkCode";
import {
  ADMIN_REASON_LABELS,
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
        if (!img) setError("The server returned no image.");
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(fail(err));
      });
    return () => {
      cancelled = true;
      current?.revoke();
    };
  }, [api, fail, report.id, canLoad]);

  if (report.restricted) {
    return (
      <p className="rounded-md bg-purple-50 p-3 text-sm text-purple-900" data-testid="evidence-restricted">
        Restricted: this item was routed to the CSAM store. The image is never shown in the console. Use Escalate CSAM to
        build the report packet from metadata.
      </p>
    );
  }
  if (!report.hasFrame) return <p className="text-sm text-gray-500">No image was attached.</p>;
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!image) return <p className="text-sm text-gray-500">Loading the image...</p>;

  return (
    <div className="space-y-2">
      <div className="inline-block overflow-hidden rounded-md border border-gray-300 bg-gray-200">
        <img
          src={image.src}
          alt={blurred ? "Evidence frame, blurred" : "Evidence frame"}
          data-testid="evidence-image"
          data-blurred={blurred ? "true" : "false"}
          className="block max-h-64 max-w-full"
          style={{ filter: blurred ? "blur(16px) grayscale(1)" : "none" }}
        />
      </div>
      <div>
        <Btn onClick={() => setBlurred((b) => !b)} aria-pressed={!blurred}>
          {blurred ? "Unblur" : "Blur again"}
        </Btn>
      </div>
    </div>
  );
};

export const ReportDetail: React.FC<ReportDetailProps> = ({ report, onChanged }) => {
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
        if (!res.packet) throw new AdminApiError(500, "The server did not send the report packet.");
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
    void run({ action: "restrict", reason: restrictReason, durationMs: duration.ms }, `Restricted for ${duration.label}.`);
  };

  return (
    <article className="space-y-4 rounded-lg border border-gray-200 bg-white p-4" data-testid="report-detail">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase ${SEVERITY_TONE[report.severity]}`}>
            {report.severity}
          </span>
          <h2 className="text-lg font-semibold">{ADMIN_REASON_LABELS[report.reason]}</h2>
          <span className="text-sm text-gray-500">{report.status}</span>
        </div>
        {!closed && (
          <div className="flex flex-wrap gap-2">
            {report.status === "open" && <SlaChip label="Acknowledge" dueAt={report.ackDueAt} now={now} />}
            <SlaChip label="Resolve" dueAt={report.resolveDueAt} now={now} />
          </div>
        )}
      </header>

      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-500">Received</dt>
        <dd>{formatTime(report.createdAt)}</dd>
        <dt className="text-gray-500">Watermark code</dt>
        <dd className="font-mono" data-testid="detail-watermark">
          {watermarkCode(report.roomId)}
        </dd>
        <dt className="text-gray-500">Reported device</dt>
        <dd className="break-all font-mono text-xs">{report.reported}</dd>
        <dt className="text-gray-500">Prior reports against</dt>
        <dd>{report.priorReportsAgainst}</dd>
        <dt className="text-gray-500">Reporter</dt>
        <dd className="break-all">
          <span className="font-mono text-xs">{report.reporter}</span> (weight {report.reporterWeight.toFixed(2)})
        </dd>
        <dt className="text-gray-500">Classifier score</dt>
        <dd data-testid="detail-score">{report.nsfwScore === null ? "not available" : report.nsfwScore.toFixed(2)}</dd>
        <dt className="text-gray-500">Details</dt>
        <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{report.details ?? "none"}</dd>
      </dl>

      <section aria-labelledby="evidence-title" className="space-y-2">
        <h3 id="evidence-title" className="font-semibold">
          Evidence <span className="text-xs font-normal text-gray-500">submitted by the reporter, unverified</span>
        </h3>
        <Evidence report={report} />
      </section>

      <section aria-labelledby="chat-title" className="space-y-2">
        <h3 id="chat-title" className="font-semibold">
          Chat ({report.chat.length})
        </h3>
        {report.chat.length === 0 ? (
          <p className="text-sm text-gray-500">No chat lines were attached.</p>
        ) : (
          <ol className="space-y-1 text-sm" data-testid="detail-chat">
            {report.chat.map((line, i) => (
              <li key={i} className="[overflow-wrap:anywhere]">
                <span className={`font-semibold ${line.from === "reported" ? "text-red-700" : "text-gray-700"}`}>
                  {line.from === "reported" ? "Reported" : "Reporter"}:
                </span>{" "}
                {line.text}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="actions-title" className="space-y-3 border-t border-gray-200 pt-3">
        <h3 id="actions-title" className="font-semibold">
          Actions
        </h3>
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600">Note (kept in the audit log)</span>
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
            <Btn disabled={busy} onClick={() => void run({ action: "acknowledge" }, "Acknowledged.")}>
              Acknowledge
            </Btn>
          )}
          <Btn disabled={busy} onClick={() => void run({ action: "dismiss" }, "Dismissed.")}>
            Dismiss
          </Btn>
          <Btn
            disabled={busy}
            onClick={() => void run({ action: "warn", reason: restrictReason }, "Warning sent.")}
          >
            Warn
          </Btn>
        </div>
        <fieldset className="flex flex-wrap items-end gap-2 rounded-md border border-gray-200 p-3">
          <legend className="px-1 text-sm font-medium">Restrict</legend>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">Reason</span>
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
            <span className="mb-1 block text-gray-600">Duration</span>
            <select
              value={durationIndex}
              onChange={(e) => setDurationIndex(Number(e.target.value))}
              className="rounded-md border border-gray-300 p-1.5"
            >
              {DURATION_PRESETS.map((d, i) => (
                <option key={d.label} value={i}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <Btn tone="primary" disabled={busy} onClick={restrict}>
            Restrict
          </Btn>
        </fieldset>
        <div>
          <Btn tone="danger" disabled={busy} onClick={() => setConfirm({ kind: "csam" })}>
            Escalate CSAM
          </Btn>
        </div>
        {result && <Notice tone={result.tone}>{result.text}</Notice>}
      </section>

      <ConfirmDialog
        open={confirm?.kind === "permanent"}
        title="Restrict permanently?"
        description={<p>This device will not be able to match again unless an appeal overturns it.</p>}
        confirmLabel="Restrict permanently"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void run({ action: "restrict", reason: restrictReason, durationMs: null }, "Restricted permanently.");
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "csam"}
        title="Escalate as CSAM?"
        description={
          <>
            <p>The evidence is frozen for 1 year and the report packet for the NCMEC CyberTipline and NCRP is downloaded.</p>
            <p>The packet is built from metadata; you do not need to open the image. Follow the CSAM runbook.</p>
          </>
        }
        confirmLabel="Escalate and download packet"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void run({ action: "escalate_csam" }, "Escalated. The packet was downloaded.");
        }}
      />
    </article>
  );
};
