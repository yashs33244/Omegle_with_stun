import React, { useEffect, useState } from "react";
import { Coins, Heart, Home, Settings, SkipForward, Loader } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/retroui/Button";
import { ConnectionIndicator } from "@/components/ConnectionIndicator";
import { formatConnectionTime } from "@/lib/utils";
import type { ConnectionQuality } from "@/lib/peerSession";

interface RoomHeaderProps {
  isMobile: boolean;
  coins: number | null;
  /** Changes on every coin gain, replaying the pop animation. */
  coinBump: number;
  isFriend: boolean;
  inCall: boolean;
  callStartedAt: number | null;
  quality: ConnectionQuality;
  reconnecting: boolean;
  onHome: () => void;
  onSettings: () => void;
  onSkip: () => void;
}

function useElapsedSeconds(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

export const RoomHeader: React.FC<RoomHeaderProps> = ({
  isMobile,
  coins,
  coinBump,
  isFriend,
  inCall,
  callStartedAt,
  quality,
  reconnecting,
  onHome,
  onSettings,
  onSkip,
}) => {
  const { t } = useTranslation("room");
  const elapsed = useElapsedSeconds(inCall ? callStartedAt : null);

  return (
    <div
      className={`flex items-center justify-between ${
        isMobile ? "p-2" : "p-4"
      } bg-black bg-opacity-80 backdrop-blur-sm border-b border-gray-700`}
    >
      <div className={`flex items-center ${isMobile ? "gap-2" : "gap-4"}`}>
        <button
          type="button"
          onClick={onHome}
          aria-label={t("header.home")}
          className="text-yellow-400 hover:text-yellow-300 transition-colors"
        >
          <h1 className={`${isMobile ? "text-lg" : "text-2xl"} font-bold`}>{t("appName", { ns: "common" })}</h1>
        </button>
        <div
          key={coinBump}
          aria-label={coins === null ? t("header.coinsLoading") : t("header.coins", { coins })}
          className={`coin-counter flex items-center gap-2 bg-yellow-500 bg-opacity-20 ${
            isMobile ? "px-2 py-1" : "px-3 py-1"
          } rounded-full border border-yellow-500 ${coinBump > 0 ? "animate-coin-pop" : ""}`}
        >
          <Coins className={`${isMobile ? "w-4 h-4" : "w-5 h-5"} text-yellow-400`} />
          <span className={`font-bold text-yellow-400 ${isMobile ? "text-sm" : ""}`}>{coins ?? "--"}</span>
        </div>
        {isFriend && (
          <div
            className={`flex items-center gap-2 bg-pink-500 bg-opacity-20 ${
              isMobile ? "px-2 py-1" : "px-3 py-1"
            } rounded-full border border-pink-500`}
          >
            <Heart className={`${isMobile ? "w-4 h-4" : "w-5 h-5"} text-pink-400`} />
            <span className={`font-bold text-pink-400 ${isMobile ? "text-sm" : ""}`}>{t("header.friends")}</span>
          </div>
        )}
        {reconnecting && (
          <div role="status" className="flex items-center gap-2 text-sm text-orange-300">
            <Loader className="w-4 h-4 animate-spin" />
            {!isMobile && t("header.reconnecting")}
          </div>
        )}
      </div>

      <div className={`flex items-center ${isMobile ? "gap-1" : "gap-4"}`}>
        {inCall && (
          <div className="flex items-center gap-2 text-white text-sm">
            <ConnectionIndicator quality={quality} />
            {!isMobile && <span>{t("header.connected", { time: formatConnectionTime(elapsed) })}</span>}
          </div>
        )}
        <Button
          onClick={onSettings}
          variant="outline"
          size="sm"
          aria-label={t("header.settings")}
          className={`flex items-center ${
            isMobile ? "gap-1 px-2" : "gap-2"
          } bg-gray-800 border-gray-600 text-white hover:bg-gray-700`}
        >
          <Settings className="w-4 h-4" />
          {!isMobile && t("header.settings")}
        </Button>
        {inCall && (
          <Button
            onClick={onSkip}
            variant="outline"
            size="sm"
            aria-label={t("header.skip")}
            data-testid="skip-button"
            className={`flex items-center ${
              isMobile ? "gap-1 px-2" : "gap-2"
            } bg-orange-600 border-orange-500 text-white hover:bg-orange-500`}
          >
            <SkipForward className="w-4 h-4" />
            {!isMobile && t("header.skip")}
          </Button>
        )}
        <Button
          onClick={onHome}
          variant="outline"
          size="sm"
          aria-label={t("header.homeButton")}
          className={`flex items-center ${
            isMobile ? "gap-1 px-2" : "gap-2"
          } bg-gray-800 border-gray-600 text-white hover:bg-gray-700`}
        >
          <Home className="w-4 h-4" />
          {!isMobile && t("header.homeButton")}
        </Button>
      </div>
    </div>
  );
};
