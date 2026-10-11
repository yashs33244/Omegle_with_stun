import React from "react";
import { useTranslation } from "react-i18next";
import { EyeOff, Flag, ShieldCheck, SkipForward } from "lucide-react";
import type { BlurStatus } from "./blurGate";

interface RemoteBlurOverlayProps {
  status: BlurStatus;
  /** "Tap to show video" after the safety check could not run. */
  onReveal: () => void;
  onReport: () => void;
  onNext: () => void;
}

/** What sits on top of the partner's (blurred) video while the safety check decides. */
export const RemoteBlurOverlay: React.FC<RemoteBlurOverlayProps> = ({ status, onReveal, onReport, onNext }) => {
  const { t } = useTranslation("safety");
  if (status === "checking") {
    return (
      <div className="absolute top-14 inset-x-0 flex justify-center pointer-events-none" style={{ zIndex: 6 }}>
        <div
          role="status"
          data-testid="video-checking"
          className="flex items-center gap-2 bg-black bg-opacity-70 text-white text-xs px-3 py-1 rounded-full"
        >
          <ShieldCheck className="w-4 h-4 text-green-400" aria-hidden="true" />
          {t("blur.checking")}
        </div>
      </div>
    );
  }

  if (status === "flagged") {
    return (
      <div className="video-loading-overlay" role="alert" data-testid="video-hidden" style={{ zIndex: 20 }}>
        <div className="text-center text-white space-y-4 px-4">
          <EyeOff className="w-12 h-12 text-red-400 mx-auto" aria-hidden="true" />
          <p className="text-lg font-bold">{t("blur.hiddenTitle")}</p>
          <p className="text-sm text-gray-300">{t("blur.hiddenBody")}</p>
          <div className="flex gap-3 justify-center">
            <button type="button" onClick={onReport} className="retro-button bg-red-500 text-white" data-testid="hidden-report">
              <Flag className="w-4 h-4 inline mr-2" aria-hidden="true" />
              {t("blur.report")}
            </button>
            <button type="button" onClick={onNext} className="retro-button" data-testid="hidden-next">
              <SkipForward className="w-4 h-4 inline mr-2" aria-hidden="true" />
              {t("blur.next")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="video-loading-overlay" data-testid="video-unchecked" style={{ zIndex: 20 }}>
        <div className="text-center text-white space-y-4 px-4">
          <EyeOff className="w-12 h-12 text-yellow-400 mx-auto" aria-hidden="true" />
          <p className="text-lg font-bold">{t("blur.blurredTitle")}</p>
          <p className="text-sm text-gray-300">{t("blur.blurredBody")}</p>
          <div className="flex gap-3 justify-center">
            <button type="button" onClick={onReveal} className="retro-button" data-testid="tap-to-show">
              {t("blur.reveal")}
            </button>
            <button type="button" onClick={onNext} className="retro-button">
              {t("blur.next")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
};
