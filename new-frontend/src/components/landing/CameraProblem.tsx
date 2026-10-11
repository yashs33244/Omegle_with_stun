import React from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/retroui/Button";
import type { MediaAccessError } from "@/hooks/useMediaStream";

/** Why the camera is not running, with a retry. Compact enough to sit inside the preview tile. */
export const CameraProblem: React.FC<{ error: MediaAccessError; onRetry: () => void }> = ({ error, onRetry }) => {
  const { t } = useTranslation(["landing", "room"]);
  return (
    <div role="alert" className="text-center space-y-2 px-4 py-3" data-testid="camera-error">
      <AlertTriangle className="w-8 h-8 mx-auto text-yellow-400" aria-hidden="true" />
      <p className="font-bold text-white leading-tight">{t(`room:camera.${error.kind}.title`)}</p>
      <p className="text-xs text-gray-300">{t(`room:camera.${error.kind}.message`)}</p>
      <Button onClick={onRetry} size="sm" className="mx-auto min-h-tap bg-yellow-400 text-black hover:bg-yellow-300">
        {t("landing:camera.tryAgain")}
      </Button>
    </div>
  );
};
