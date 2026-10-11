import React, { useEffect, useState } from "react";
import { ChevronLeft, Coins, Heart, Loader, Settings, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ConnectionIndicator } from "@/components/ConnectionIndicator";
import { getCountryByCode } from "@/lib/data";
import { formatConnectionTime } from "@/lib/utils";
import type { ConnectionQuality } from "@/lib/peerSession";
import type { PublicProfile } from "@/lib/protocol";

interface RoomHeaderProps {
  coins: number | null;
  /** Changes on every coin gain, replaying the pop animation. */
  coinBump: number;
  isFriend: boolean;
  inCall: boolean;
  callStartedAt: number | null;
  quality: ConnectionQuality;
  reconnecting: boolean;
  /** Shown in the middle of the bar while matched or in a call. */
  partner: PublicProfile | null;
  /** A topic both of you picked, already translated. */
  sharedTopic: string | null;
  partnerSpeaking: boolean;
  onHome: () => void;
  onSettings: () => void;
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

const ICON_BUTTON =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400";

/**
 * Translucent bar floating over the top of the video: back, who you are
 * talking to, connection and call time, coins, settings. Pads itself for the
 * notch (safe-area-inset-top).
 */
export const RoomHeader: React.FC<RoomHeaderProps> = ({
  coins,
  coinBump,
  isFriend,
  inCall,
  callStartedAt,
  quality,
  reconnecting,
  partner,
  sharedTopic,
  partnerSpeaking,
  onHome,
  onSettings,
}) => {
  const { t } = useTranslation("room");
  const elapsed = useElapsedSeconds(inCall ? callStartedAt : null);
  const country = partner ? getCountryByCode(partner.country) : undefined;
  const time = formatConnectionTime(elapsed);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-[35] bg-gradient-to-b from-black/80 via-black/40 to-transparent pb-6 pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] pt-[max(0.5rem,env(safe-area-inset-top))]"
      data-testid="room-header"
    >
      <div className="pointer-events-auto flex items-center gap-2">
        <button type="button" onClick={onHome} aria-label={t("header.homeButton")} className={ICON_BUTTON}>
          <ChevronLeft className="h-6 w-6" aria-hidden="true" />
        </button>

        {partner ? (
          <div className="flex min-w-0 flex-1 items-center">
            <div
              className="flex min-w-0 max-w-full items-center gap-2 rounded-full bg-black/50 py-1.5 pl-2 pr-3 text-white backdrop-blur-sm"
              data-testid="partner-chip"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-700 max-[379px]:hidden">
                <UserRound className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 truncate text-sm font-semibold">{partner.name}</span>
              {country && (
                <span className="text-sm" aria-hidden="true">
                  {country.flag}
                </span>
              )}
              {partnerSpeaking && <span className="h-2 w-2 shrink-0 rounded-full bg-yellow-400" aria-hidden="true" />}
              {sharedTopic && (
                <span className="hidden max-w-[8rem] truncate rounded-full bg-yellow-400/20 px-2 py-0.5 text-xs font-medium text-yellow-300 sm:inline">
                  {sharedTopic}
                </span>
              )}
            </div>
          </div>
        ) : (
          <span className="rounded-full bg-black/50 px-3 py-1.5 text-base font-bold text-yellow-400 backdrop-blur-sm">
            {t("appName", { ns: "common" })}
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {reconnecting && (
            <div role="status" className="flex items-center gap-1 text-sm text-orange-300">
              <Loader className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span className="hidden lg:inline">{t("header.reconnecting")}</span>
            </div>
          )}
          {inCall && (
            <div className="flex items-center gap-2 rounded-full bg-black/50 px-2 py-1.5 text-sm text-white backdrop-blur-sm lg:px-3">
              <ConnectionIndicator quality={quality} />
              <span className="hidden tabular-nums sm:inline lg:hidden">{time}</span>
              <span className="hidden tabular-nums lg:inline">{t("header.connected", { time })}</span>
            </div>
          )}
          {isFriend && (
            <div className="flex items-center gap-1 rounded-full border border-pink-500 bg-pink-500/20 px-2 py-1 backdrop-blur-sm">
              <Heart className="h-4 w-4 text-pink-400" aria-hidden="true" />
              <span className="hidden text-sm font-bold text-pink-400 sm:inline">{t("header.friends")}</span>
            </div>
          )}
          <div
            key={coinBump}
            role="status"
            aria-label={coins === null ? t("header.coinsLoading") : t("header.coins", { coins })}
            className={`coin-counter flex items-center gap-1 rounded-full border border-yellow-500 bg-black/50 px-2 py-1 backdrop-blur-sm ${
              coinBump > 0 ? "animate-coin-pop motion-reduce:animate-none" : ""
            }`}
          >
            <Coins className="h-4 w-4 text-yellow-400" aria-hidden="true" />
            <span className="text-sm font-bold tabular-nums text-yellow-400">{coins ?? "--"}</span>
          </div>
          <button type="button" onClick={onSettings} aria-label={t("header.settings")} className={ICON_BUTTON}>
            <Settings className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
};
