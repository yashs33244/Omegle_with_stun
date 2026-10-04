import React, { useState } from "react";
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
        <h1 className="text-2xl font-bold text-yellow-400">Open Chizzy in {browser}</h1>
        <p className="text-gray-200">
          You opened this link inside {app}. Its built-in browser often cannot use your camera, so video chat may not work here.
        </p>
        <ol className="list-decimal list-inside space-y-1 text-sm text-gray-300">
          {platform === "ios" ? (
            <>
              <li>Tap the menu (the three dots or the share button).</li>
              <li>Choose "Open in Safari" or "Open in browser".</li>
            </>
          ) : (
            <>
              <li>Tap the menu (the three dots, top right).</li>
              <li>Choose "Open in Chrome" or "Open in browser".</li>
            </>
          )}
          <li>Or copy the link below and paste it into {browser}.</li>
        </ol>
        <div className="flex flex-wrap gap-3">
          {intent && (
            <a href={intent} className="retro-button flex items-center gap-2" data-testid="open-in-chrome">
              <ExternalLink className="w-4 h-4" aria-hidden="true" />
              Open in Chrome
            </a>
          )}
          <button type="button" onClick={copy} className="retro-button flex items-center gap-2" data-testid="copy-link">
            <Copy className="w-4 h-4" aria-hidden="true" />
            Copy link
          </button>
        </div>
        <p role="status" className="text-sm text-gray-300 break-all">
          {copied === "done" ? "Link copied." : copied === "failed" ? `Copy this link: ${url}` : url}
        </p>
        <button type="button" onClick={onContinue} className="text-sm text-gray-400 underline hover:text-white">
          Continue here anyway
        </button>
      </div>
    </div>
  );
};
