import React, { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Flag, X } from "lucide-react";
import { POST_CALL_REPORT_MS, type PostCall } from "./useCallSafety";

interface PostCallReportProps {
  postCall: PostCall;
  onReport: () => void;
  onDismiss: () => void;
}

/**
 * Offered for 60 s after a call ends: the window in which the server still accepts a report.
 * Sits in the band under the top bar so the waiting screen's footer (Stop searching) stays reachable.
 */
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
      className="fixed left-1/2 z-40 w-[calc(100%-1.5rem)] max-w-sm -translate-x-1/2 rounded-xl border-2 border-black bg-gray-900/95 p-3 text-white shadow-[0_4px_0_#000] backdrop-blur-sm"
      style={{ top: "calc(env(safe-area-inset-top) + 4.5rem)" }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 pt-1">
          <p className="text-sm font-semibold">{t("postCall.question", { who })}</p>
          <p className="mt-0.5 text-xs text-gray-300">
            <Trans t={t} i18nKey="postCall.countdown" values={{ seconds }} components={{ s: <span data-testid="post-call-seconds" /> }} />
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("postCall.dismiss")}
          className="-mr-2 -mt-2 flex h-tap w-tap shrink-0 items-center justify-center rounded-full text-gray-300 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      <button
        type="button"
        onClick={onReport}
        data-testid="post-call-report-button"
        className="mt-2 flex min-h-tap w-full items-center justify-center gap-2 rounded-full border-2 border-black bg-red-600 px-3 text-sm font-semibold shadow-[0_3px_0_#000] hover:bg-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400"
      >
        <Flag className="h-4 w-4" aria-hidden="true" />
        {t("postCall.report")}
      </button>
    </section>
  );
};
