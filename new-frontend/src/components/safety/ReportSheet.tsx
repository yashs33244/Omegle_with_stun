import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Flag, X } from "lucide-react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { buildEvidence, type ReportEvidence } from "@/lib/evidence";
import { LIMITS, type ReportAck, type ReportReason } from "@/lib/protocol";
import { REPORT_CHOICES } from "./reportReasons";
import { reportErrorKey, type ReportErrorKey } from "./safetyText";
import type { ReportTarget } from "./useCallSafety";

interface ReportSheetProps {
  target: ReportTarget;
  onSubmit: (roomId: string, reason: ReportReason, details?: string, evidence?: ReportEvidence) => Promise<ReportAck>;
  onClose: () => void;
}

type Phase = { name: "form"; error: ReportErrorKey | null } | { name: "sending" } | { name: "done"; reportId: string };

const LEAD = {
  call: "reportSheet.lead.call",
  match: "reportSheet.lead.match",
  "post-call": "reportSheet.lead.postCall",
} as const satisfies Record<ReportTarget["context"], string>;

const FRAME_WHEN = {
  call: "reportSheet.frameWhen.call",
  match: "reportSheet.frameWhen.match",
  "post-call": "reportSheet.frameWhen.postCall",
} as const satisfies Record<ReportTarget["context"], string>;

/**
 * The report sheet: pick a reason, see exactly what is attached, send.
 * The server ack is shown as is; we promise nothing about timing.
 */
export const ReportSheet: React.FC<ReportSheetProps> = ({ target, onSubmit, onClose }) => {
  const { t } = useTranslation("safety");
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [includeFrame, setIncludeFrame] = useState(true);
  const [includeChat, setIncludeChat] = useState(true);
  const [phase, setPhase] = useState<Phase>({ name: "form", error: null });
  const sheetRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(true, sheetRef);

  useEffect(() => {
    if (phase.name === "done") doneRef.current?.focus();
  }, [phase.name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasFrame = target.frame !== null;
  const chatCount = target.chat.length;
  const who = target.partnerName ? target.partnerName : t("reportSheet.defaultWho");
  const title = target.context === "post-call" ? t("reportSheet.titlePostCall") : t("reportSheet.title", { who });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason || phase.name === "sending") return;
    setPhase({ name: "sending" });
    const evidence = buildEvidence(includeFrame ? target.frame : null, includeChat ? target.chat : []);
    const res = await onSubmit(target.roomId, reason, details.trim() || undefined, evidence);
    setPhase(res.ok ? { name: "done", reportId: res.reportId } : { name: "form", error: reportErrorKey(res) });
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && phase.name !== "sending") onClose();
      }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-sheet-title"
        data-testid="report-sheet"
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border border-gray-700 bg-gray-800 p-5 text-white sm:max-w-md sm:rounded-lg"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="report-sheet-title" className="flex items-center gap-2 text-lg font-semibold">
            <Flag className="h-5 w-5 text-red-400" aria-hidden="true" />
            {phase.name === "done" ? t("reportSheet.titleDone") : title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("reportSheet.close")}
            className="rounded-md border border-gray-600 bg-gray-700 p-1.5 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-yellow-400"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {phase.name === "done" ? (
          <div className="space-y-4">
            <div role="status" data-testid="report-received" className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-green-400" aria-hidden="true" />
              <div>
                <p className="font-medium">{t("reportSheet.received")}</p>
                <p className="mt-1 text-xs text-gray-400">
                  {t("reportSheet.reference")} <span className="font-mono" data-testid="report-reference">{phase.reportId.slice(0, 8)}</span>
                </p>
              </div>
            </div>
            <button type="button" ref={doneRef} onClick={onClose} className="retro-button w-full">
              {t("reportSheet.closeButton")}
            </button>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="space-y-4">
            <p className="text-sm text-gray-300">{t(LEAD[target.context])}</p>

            <fieldset>
              <legend className="mb-2 text-sm font-medium">{t("reportSheet.whatHappened")}</legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {REPORT_CHOICES.map((choice) => (
                  <label
                    key={choice.reason}
                    className={`flex cursor-pointer flex-col rounded-lg border p-2.5 text-sm focus-within:ring-2 focus-within:ring-yellow-400 ${
                      reason === choice.reason ? "border-red-400 bg-red-500/20" : "border-gray-600 bg-gray-700 hover:bg-gray-600"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="report-reason"
                        value={choice.reason}
                        checked={reason === choice.reason}
                        onChange={() => setReason(choice.reason)}
                        className="accent-red-500"
                      />
                      <span className="font-medium">{t(choice.labelKey)}</span>
                    </span>
                    <span className="ml-5 text-xs text-gray-400">{t(choice.hintKey)}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label htmlFor="report-sheet-details" className="mb-1 block text-sm font-medium">
                {t("reportSheet.detailsLabel")}
              </label>
              <textarea
                id="report-sheet-details"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                maxLength={LIMITS.reportDetailsMax}
                rows={2}
                className="w-full resize-none rounded-lg border border-gray-600 bg-gray-700 p-2 text-sm text-white placeholder-gray-400 focus:border-yellow-500 focus:outline-none"
                placeholder={t("reportSheet.detailsPlaceholder")}
              />
            </div>

            <fieldset className="rounded-lg border border-gray-700 p-3" data-testid="report-attachments">
              <legend className="px-1 text-sm font-medium">{t("reportSheet.attachedLegend")}</legend>
              {!hasFrame && chatCount === 0 ? (
                <p className="text-sm text-gray-300">{t("reportSheet.nothingAttached")}</p>
              ) : (
                <div className="space-y-2 text-sm">
                  {hasFrame && (
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={includeFrame}
                        onChange={(e) => setIncludeFrame(e.target.checked)}
                        data-testid="attach-frame"
                        className="mt-1"
                      />
                      <span>
                        {t("reportSheet.frameLabel")}
                        <span className="block text-xs text-gray-400">{t(FRAME_WHEN[target.context])}</span>
                      </span>
                    </label>
                  )}
                  {chatCount > 0 && (
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={includeChat}
                        onChange={(e) => setIncludeChat(e.target.checked)}
                        data-testid="attach-chat"
                        className="mt-1"
                      />
                      <span>
                        {t("reportSheet.chatLabel", { count: chatCount })}
                        <span className="block text-xs text-gray-400">{t("reportSheet.chatWho")}</span>
                      </span>
                    </label>
                  )}
                </div>
              )}
              <p className="mt-2 text-xs text-gray-400">{t("reportSheet.onlyChecked")}</p>
            </fieldset>

            {phase.name === "form" && phase.error && (
              <p role="alert" className="text-sm text-red-400">
                {"values" in phase.error ? t(phase.error.key, phase.error.values) : t(phase.error.key)}
              </p>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-lg border border-gray-600 bg-gray-700 px-4 py-2 font-medium hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-yellow-400"
              >
                {t("reportSheet.cancel")}
              </button>
              <button
                type="submit"
                disabled={!reason || phase.name === "sending"}
                data-testid="report-submit"
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 font-semibold hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {phase.name === "sending" ? t("reportSheet.sending") : t("reportSheet.send")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
