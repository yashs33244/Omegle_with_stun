import React, { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Flag, X } from "lucide-react";
import { POST_CALL_REPORT_MS, type PostCall } from "./useCallSafety";

interface PostCallReportProps {
  postCall: PostCall;
  onReport: () => void;
  onDismiss: () => void;
}

/** Offered for 60 s after a call ends: the window in which the server still accepts a report. */
export const PostCallReport: React.FC<PostCallReportProps> = ({ postCall, onReport, onDismiss }) => {
  const { t } = useTranslation("safety");
  const deadline = postCall.endedAt + POST_CALL_REPORT_MS;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  const who = postCall.partnerName ?? t("postCall.defaultWho");

  return (
    <section
      aria-label={t("postCall.aria")}
      data-testid="post-call-report"
      className="fixed bottom-4 left-1/2 z-40 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 rounded-lg border border-gray-600 bg-gray-800/95 p-3 text-white shadow-lg"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("postCall.question", { who })}</p>
          <p className="text-xs text-gray-400">
            <Trans t={t} i18nKey="postCall.countdown" values={{ seconds }} components={{ s: <span data-testid="post-call-seconds" /> }} />
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("postCall.dismiss")}
          className="rounded p-1 text-gray-300 hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-yellow-400"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <button
        type="button"
        onClick={onReport}
        data-testid="post-call-report-button"
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-yellow-400"
      >
        <Flag className="h-4 w-4" aria-hidden="true" />
        {t("postCall.report")}
      </button>
    </section>
  );
};
