import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Flag } from "lucide-react";
import { BottomSheet } from "@/components/ui/BottomSheet";
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

const FORM_ID = "report-sheet-form";

const FOOTER_BUTTON =
  "flex min-h-tap flex-1 items-center justify-center rounded-full border-2 border-black px-4 font-semibold text-white shadow-[0_3px_0_#000] focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The report sheet: pick a reason, see exactly what is attached, send.
 * The server ack is shown as is; we promise nothing about timing.
 * Built on the shared BottomSheet: the title stays put, Send and Cancel sit
 * in the sticky footer above the home indicator, and the sheet cannot be
 * dismissed while the report is on its way.
 */
export const ReportSheet: React.FC<ReportSheetProps> = ({ target, onSubmit, onClose }) => {
  const { t } = useTranslation("safety");
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [includeFrame, setIncludeFrame] = useState(true);
  const [includeChat, setIncludeChat] = useState(true);
  const [phase, setPhase] = useState<Phase>({ name: "form", error: null });
  const doneRef = useRef<HTMLButtonElement>(null);
  const sending = phase.name === "sending";

  useEffect(() => {
    if (phase.name === "done") doneRef.current?.focus();
  }, [phase.name]);

  const keepOpenWhileSending = (event: { preventDefault: () => void }) => {
    if (sending) event.preventDefault();
  };

  const hasFrame = target.frame !== null;
  const chatCount = target.chat.length;
  const who = target.partnerName ? target.partnerName : t("reportSheet.defaultWho");
  const title = target.context === "post-call" ? t("reportSheet.titlePostCall") : t("reportSheet.title", { who });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason || sending) return;
    setPhase({ name: "sending" });
    const evidence = buildEvidence(includeFrame ? target.frame : null, includeChat ? target.chat : []);
    const res = await onSubmit(target.roomId, reason, details.trim() || undefined, evidence);
    setPhase(res.ok ? { name: "done", reportId: res.reportId } : { name: "form", error: reportErrorKey(res) });
  };

  const footer =
    phase.name === "done" ? (
      <button type="button" ref={doneRef} onClick={onClose} className="retro-button w-full">
        {t("reportSheet.closeButton")}
      </button>
    ) : (
      <div className="flex gap-3">
        <button type="button" onClick={onClose} disabled={sending} className={`${FOOTER_BUTTON} bg-gray-800 hover:bg-gray-700`}>
          {t("reportSheet.cancel")}
        </button>
        <button
          type="submit"
          form={FORM_ID}
          disabled={!reason || sending}
          data-testid="report-submit"
          className={`${FOOTER_BUTTON} bg-red-600 hover:bg-red-500`}
        >
          {sending ? t("reportSheet.sending") : t("reportSheet.send")}
        </button>
      </div>
    );

  return (
    <BottomSheet
      open
      onOpenChange={(open) => {
        if (!open && !sending) onClose();
      }}
      title={
        <span className="flex items-center gap-2">
          <Flag className="h-5 w-5 text-red-400" aria-hidden="true" />
          {phase.name === "done" ? t("reportSheet.titleDone") : title}
        </span>
      }
      closeLabel={t("reportSheet.close")}
      data-testid="report-sheet"
      onEscapeKeyDown={keepOpenWhileSending}
      onPointerDownOutside={keepOpenWhileSending}
      footer={footer}
    >
      {phase.name === "done" ? (
        <div role="status" data-testid="report-received" className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-green-400" aria-hidden="true" />
          <div>
            <p className="font-medium">{t("reportSheet.received")}</p>
            <p className="mt-1 text-xs text-gray-400">
              {t("reportSheet.reference")} <span className="font-mono" data-testid="report-reference">{phase.reportId.slice(0, 8)}</span>
            </p>
          </div>
        </div>
      ) : (
        <form id={FORM_ID} onSubmit={(e) => void submit(e)} className="space-y-4">
          <p className="text-sm text-gray-300">{t(LEAD[target.context])}</p>

          <fieldset>
            <legend className="mb-2 text-sm font-medium">{t("reportSheet.whatHappened")}</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {REPORT_CHOICES.map((choice) => (
                <label
                  key={choice.reason}
                  className={`flex cursor-pointer flex-col rounded-xl border-2 p-2.5 text-sm focus-within:ring-2 focus-within:ring-yellow-400 ${
                    reason === choice.reason ? "border-red-400 bg-red-500/20" : "border-black bg-gray-800 hover:bg-gray-700"
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
              className="w-full resize-none rounded-xl border-2 border-black bg-gray-800 p-2 text-sm text-white placeholder-gray-400 focus:border-yellow-400 focus:outline-none"
              placeholder={t("reportSheet.detailsPlaceholder")}
            />
          </div>

          <fieldset className="rounded-xl border-2 border-gray-700 p-3" data-testid="report-attachments">
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
        </form>
      )}
    </BottomSheet>
  );
};
