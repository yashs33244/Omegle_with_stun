import React, { useEffect, useState } from "react";
import { Check, Heart, Loader, UserRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getCountryByCode } from "@/lib/data";
import { formatTopics } from "@/lib/utils";
import type { PublicProfile } from "@/lib/protocol";
import { secondsLeft } from "@/hooks/useSignaling";
import { PartnerPhoto } from "@/moderation/PartnerPhoto";

interface MatchPromptProps {
  partner: PublicProfile;
  isFriend: boolean;
  /** Local-clock deadline (already corrected for server clock skew). */
  expiresAt: number | null;
  /** You pressed Accept and are waiting for the partner. */
  accepted: boolean;
  partnerAccepted: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

function useSecondsLeft(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [deadline]);
  return deadline === null ? null : secondsLeft(deadline, now);
}

export const MatchPrompt: React.FC<MatchPromptProps> = ({
  partner,
  isFriend,
  expiresAt,
  accepted,
  partnerAccepted,
  onAccept,
  onDecline,
}) => {
  const { t } = useTranslation("room");
  const remaining = useSecondsLeft(expiresAt);
  // Time is up: the server ends this match, so answering it does nothing.
  const expired = remaining === 0;
  const country = getCountryByCode(partner.country);

  return (
    <div
      className="w-full h-full bg-black flex items-center justify-center relative"
      style={{ zIndex: 3 }}
      data-testid="match-prompt"
    >
      {partner.photo?.startsWith("data:image/") ? (
        // Blurred on this device until the on-device classifier passes it.
        <PartnerPhoto photo={partner.photo} alt={t("match.photoAlt", { name: partner.name })} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full bg-gray-800 flex items-center justify-center">
          <UserRound className="w-32 h-32 text-gray-400" />
        </div>
      )}

      {/* Timer countdown */}
      {remaining !== null && remaining > 0 && (
        <div className="timer-text" aria-live="polite" data-testid="match-countdown">
          {t("match.countdown", { seconds: remaining })}
        </div>
      )}

      {/* Partner info overlay */}
      <div className="absolute bottom-4 left-4 bg-black bg-opacity-80 backdrop-blur-sm text-white px-4 py-2 rounded-full flex items-center gap-2">
        <UserRound className="w-4 h-4" />
        <span className="text-sm font-medium truncate min-w-0 max-w-[10rem]">{partner.name}</span>
        {country && <span className="text-sm">{country.flag}</span>}
      </div>

      {/* Accept/Reject buttons */}
      <div className="match-overlay" style={{ zIndex: 4 }}>
        <div className="text-center space-y-6 px-4">
          <div className="text-white space-y-2">
            <h3 className="text-2xl font-bold">{t("match.title")}</h3>
            <p className="text-gray-300">
              {country
                ? t("match.partnerFrom", { name: partner.name, country: t(`landing:countries.${country.code}`, { defaultValue: country.name }) })
                : partner.name}
            </p>
            <p className="text-sm text-gray-400">{t("match.interestedIn", { topics: formatTopics(partner.topics) })}</p>
            {isFriend && (
              <p className="text-sm text-pink-400 flex items-center justify-center gap-1">
                <Heart className="w-4 h-4" /> {t("match.friends")}
              </p>
            )}
            {partnerAccepted && !accepted && (
              <div className="bg-green-500 bg-opacity-20 border border-green-500 rounded-lg p-2 mt-3">
                <p className="text-green-400 text-sm">
                  {t("match.partnerAccepted", { name: partner.name })}
                </p>
              </div>
            )}
          </div>

          {accepted ? (
            <div className="flex items-center justify-center gap-3 text-white">
              <Loader className="w-5 h-5 text-yellow-400 animate-spin" />
              <span>
                {partnerAccepted ? t("match.bothAccepted") : t("match.waitingFor", { name: partner.name })}
              </span>
            </div>
          ) : (
            <div className="space-y-3">
              {expired && (
                <p className="text-gray-300" role="status">
                  {t("match.expired")}
                </p>
              )}
              <div className="flex gap-4 justify-center">
                <button
                  type="button"
                  onClick={onDecline}
                  disabled={expired}
                  data-testid="match-decline"
                  className="retro-button bg-red-500 border-red-600 text-white hover:bg-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <X className="w-5 h-5 inline mr-2" />
                  {t("match.pass")}
                </button>
                <button
                  type="button"
                  onClick={onAccept}
                  disabled={expired}
                  data-testid="match-accept"
                  className="retro-button bg-green-500 border-green-600 text-white hover:bg-green-400 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Check className="w-5 h-5 inline mr-2" />
                  {t("match.accept")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
