import React from "react";
import { LockOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BottomSheet } from "@/components/ui/BottomSheet";

interface PrivateUnavailableSheetProps {
  /** Leave this match (the Next button's call:skip). Also what dismissing the sheet does. */
  onSkip: () => void;
  /** Start the call over a direct connection, exposing the IP to the partner. */
  onContinue: () => void;
}

const BUTTON =
  "flex min-h-tap flex-1 items-center justify-center rounded-full border-2 border-black px-4 font-semibold shadow-[0_3px_0_#000] focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400";

/**
 * Hide my IP is on but this call cannot use the relay. No connection exists
 * while this is open (usePeerConnection.privateBlocked): the user picks Skip
 * (the safe default) or a direct connection. Closing it any other way is Skip.
 */
export const PrivateUnavailableSheet: React.FC<PrivateUnavailableSheetProps> = ({ onSkip, onContinue }) => {
  const { t } = useTranslation("room");
  return (
    <BottomSheet
      open
      onOpenChange={(open) => {
        if (!open) onSkip();
      }}
      title={
        <span className="flex items-center gap-2">
          <LockOpen className="h-5 w-5 text-yellow-400" aria-hidden="true" />
          {t("privacy.unavailableSheet.title")}
        </span>
      }
      description={t("privacy.unavailableSheet.body")}
      closeLabel={t("privacy.unavailableSheet.skip")}
      data-testid="private-unavailable-sheet"
      footer={
        <div className="flex gap-3">
          <button type="button" onClick={onSkip} data-testid="private-unavailable-skip" className={`${BUTTON} bg-yellow-400 text-black hover:bg-yellow-300`}>
            {t("privacy.unavailableSheet.skip")}
          </button>
          <button
            type="button"
            onClick={onContinue}
            data-testid="private-unavailable-continue"
            className={`${BUTTON} bg-gray-800 text-white hover:bg-gray-700`}
          >
            {t("privacy.unavailableSheet.continue")}
          </button>
        </div>
      }
    >
      <p className="text-sm text-gray-300">{t("privacy.unavailableSheet.detail")}</p>
    </BottomSheet>
  );
};
