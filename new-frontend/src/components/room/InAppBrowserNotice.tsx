import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, ExternalLink } from "lucide-react";
import { chromeIntentUrl, mobilePlatform } from "@/lib/mobile";

interface InAppBrowserNoticeProps {
  /** The app whose built-in browser this is, e.g. "Instagram". */
  app: string;
  onContinue: () => void;
}

/**
 * Shown before anything else inside social apps' built-in browsers, where the
 * camera often fails: explains how to open Chizzy in Chrome or Safari.
 */
export const InAppBrowserNotice: React.FC<InAppBrowserNoticeProps> = ({ app, onContinue }) => {
  const { t } = useTranslation("safety");
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const url = window.location.href;
  const platform = mobilePlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  const intent = platform === "android" ? chromeIntentUrl(url) : null;
  const browser = platform === "ios" ? "Safari" : "Chrome";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4" data-testid="in-app-notice">
      <div className="max-w-md w-full space-y-5 bg-black border-2 border-yellow-500 rounded-lg p-6">
        <h1 className="text-2xl font-bold text-yellow-400">{t("inAppBrowser.title", { browser })}</h1>
        <p className="text-gray-200">{t("inAppBrowser.body", { app })}</p>
        <ol className="list-decimal list-inside space-y-1 text-sm text-gray-300">
          {platform === "ios" ? (
            <>
              <li>{t("inAppBrowser.steps.iosMenu")}</li>
              <li>{t("inAppBrowser.steps.iosChoose")}</li>
            </>
          ) : (
            <>
              <li>{t("inAppBrowser.steps.androidMenu")}</li>
              <li>{t("inAppBrowser.steps.androidChoose")}</li>
            </>
          )}
          <li>{t("inAppBrowser.steps.copy", { browser })}</li>
        </ol>
        <div className="flex flex-wrap gap-3">
          {intent && (
            <a href={intent} className="retro-button flex items-center gap-2" data-testid="open-in-chrome">
              <ExternalLink className="w-4 h-4" aria-hidden="true" />
              {t("inAppBrowser.openInChrome")}
            </a>
          )}
          <button type="button" onClick={copy} className="retro-button flex items-center gap-2" data-testid="copy-link">
            <Copy className="w-4 h-4" aria-hidden="true" />
            {t("inAppBrowser.copyLink")}
          </button>
        </div>
        <p role="status" className="text-sm text-gray-300 break-all">
          {copied === "done" ? t("inAppBrowser.copied") : copied === "failed" ? t("inAppBrowser.copyThis", { url }) : url}
        </p>
        <button type="button" onClick={onContinue} className="text-sm text-gray-400 underline hover:text-white">
          {t("inAppBrowser.continueAnyway")}
        </button>
      </div>
    </div>
  );
};
