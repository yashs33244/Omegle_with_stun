import React, { useState } from "react";
import { EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePhotoCheck } from "./usePhotoCheck";

interface PartnerPhotoProps {
  photo: string;
  alt: string;
  className?: string;
}

/**
 * A partner's profile photo, blurred until the on-device classifier passes it.
 * A flagged photo stays hidden; when the check cannot run, the viewer may tap to show it.
 */
export const PartnerPhoto: React.FC<PartnerPhotoProps> = ({ photo, alt, className }) => {
  const { t } = useTranslation("room");
  const verdict = usePhotoCheck(photo);
  const [revealed, setRevealed] = useState(false);
  const shown = verdict === "safe" || (verdict === "unavailable" && revealed);

  return (
    <>
      <img
        src={photo}
        alt={alt}
        data-photo-check={verdict}
        className={className}
        style={{ filter: shown ? undefined : "blur(24px)", transition: "filter 200ms" }}
      />
      {verdict === "unsafe" && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-black bg-opacity-70 text-white text-sm px-3 py-2 rounded flex items-center gap-2">
            <EyeOff className="w-4 h-4" aria-hidden="true" />
            {t("partnerPhoto.hidden")}
          </div>
        </div>
      )}
      {verdict === "unavailable" && !revealed && (
        <div className="absolute top-16 inset-x-0 flex justify-center">
          <button type="button" onClick={() => setRevealed(true)} className="retro-button text-sm">
            {t("partnerPhoto.reveal")}
          </button>
        </div>
      )}
    </>
  );
};
