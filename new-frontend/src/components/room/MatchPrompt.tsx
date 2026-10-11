import React, { useEffect, useMemo, useState } from "react";
import { Check, Heart, Loader, UserRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ReportButton } from "@/components/safety/ReportButton";
import { getCountryByCode } from "@/lib/data";
import { formatTopics } from "@/lib/utils";
import type { PublicProfile } from "@/lib/protocol";
import { secondsLeft } from "@/hooks/useSignaling";
import { PartnerPhoto } from "@/moderation/PartnerPhoto";

interface MatchPromptProps {
  partner: PublicProfile;
  /** Your own topics, to highlight the ones you share. */
  myTopics: readonly string[];
  isFriend: boolean;
  /** Local-clock deadline (already corrected for server clock skew). */
  expiresAt: number | null;
  /** You pressed Accept and are waiting for the partner. */
  accepted: boolean;
  partnerAccepted: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onReport: () => void;
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

const RING_RADIUS = 26;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** Seconds left inside a ring that empties as the accept window runs out. */
const CountdownRing: React.FC<{ remaining: number; total: number; label: string }> = ({ remaining, total, label }) => {
  const fraction = total > 0 ? Math.min(1, remaining / total) : 0;
  const urgent = remaining <= 5;
  return (
    <div className="relative h-16 w-16 shrink-0" aria-live="polite" data-testid="match-countdown-ring">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90" aria-hidden="true">
        <circle cx="32" cy="32" r={RING_RADIUS} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="5" />
        <circle
          cx="32"
          cy="32"
          r={RING_RADIUS}
          fill="none"
          stroke={urgent ? "#ef4444" : "#facc15"}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={RING_LENGTH * (1 - fraction)}
          style={{ transition: "stroke-dashoffset 250ms linear, stroke 250ms" }}
        />
      </svg>
      <span
        className={`absolute inset-0 flex items-center justify-center text-sm font-bold tabular-nums ${urgent ? "text-red-400" : "text-white"}`}
        data-testid="match-countdown"
      >
        {label}
      </span>
    </div>
  );
};

/**
 * Preview mode: who matched you, over their (checked) photo, with Accept and
 * Pass in a card at the bottom on phones and centred on desktop.
 */
export const MatchPrompt: React.FC<MatchPromptProps> = ({
  partner,
  myTopics,
  isFriend,
  expiresAt,
  accepted,
  partnerAccepted,
  onAccept,
  onDecline,
  onReport,
}) => {
  const { t } = useTranslation("room");
  const remaining = useSecondsLeft(expiresAt);
  // The full window, measured when this match arrived, so the ring starts full.
  const total = useMemo(() => (expiresAt === null ? 0 : secondsLeft(expiresAt, Date.now())), [expiresAt]);
  // Time is up: the server ends this match, so answering it does nothing.
  const expired = remaining === 0;
  const country = getCountryByCode(partner.country);
  const shared = partner.topics.filter((topic) => myTopics.includes(topic));
  const hasPhoto = !!partner.photo?.startsWith("data:image/");

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-black lg:items-center lg:justify-center" data-testid="match-prompt">
      <div className="absolute inset-0 overflow-hidden">
        {hasPhoto && partner.photo ? (
          // Blurred on this device until the on-device classifier passes it.
          <PartnerPhoto photo={partner.photo} alt={t("match.photoAlt", { name: partner.name })} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gray-800">
            <UserRound className="h-32 w-32 text-gray-500" aria-hidden="true" />
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black via-black/40 to-black/30" aria-hidden="true" />
      </div>

      <div
        className="relative mt-auto w-full rounded-t-2xl border-t-2 border-black bg-gray-900/95 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 text-white shadow-[0_-4px_0_#000] backdrop-blur lg:mt-0 lg:max-w-md lg:rounded-2xl lg:border-2 lg:pb-5 lg:shadow-[0_6px_0_#000]"
        data-testid="match-card"
      >
        <div className="flex items-start gap-3">
          <ReportButton testId="match-report-button" onClick={onReport} className="min-h-[2.75rem]" />
          <div className="ml-auto">
            {remaining !== null && remaining > 0 && (
              <CountdownRing remaining={remaining} total={total} label={t("match.countdown", { seconds: remaining })} />
            )}
          </div>
        </div>

        <div className="mt-2 flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 border-black bg-gray-700">
            <UserRound className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-yellow-400">{t("match.title")}</p>
            <p className="truncate text-xl font-bold">
              <span>{partner.name}</span>
              {country && (
                <span className="ml-2 text-base font-normal" aria-hidden="true">
                  {country.flag}
                </span>
              )}
            </p>
            {country && (
              <p className="truncate text-sm text-gray-300">{t(`landing:countries.${country.code}`, { defaultValue: country.name })}</p>
            )}
          </div>
        </div>

        <div className="mt-3 space-y-2">
          {shared.length > 0 && (
            <div className="flex flex-wrap gap-2" data-testid="shared-topics">
              {shared.map((topic) => (
                <span key={topic} className="rounded-full border border-yellow-400/60 bg-yellow-400/15 px-3 py-1 text-xs font-semibold text-yellow-300">
                  {t(`landing:topics.${topic}`, { defaultValue: topic })}
                </span>
              ))}
            </div>
          )}
          <p className="text-sm text-gray-400">{t("match.interestedIn", { topics: formatTopics(t, partner.topics) })}</p>
          {isFriend && (
            <p className="flex items-center gap-1 text-sm text-pink-400">
              <Heart className="h-4 w-4" aria-hidden="true" /> {t("match.friends")}
            </p>
          )}
          {partnerAccepted && !accepted && (
            <p className="rounded-lg border border-green-500 bg-green-500/20 p-2 text-sm text-green-300">
              {t("match.partnerAccepted", { name: partner.name })}
            </p>
          )}
          {expired && !accepted && (
            <p className="text-sm text-gray-300" role="status">
              {t("match.expired")}
            </p>
          )}
        </div>

        {accepted ? (
          <div className="mt-5 flex min-h-[3.5rem] items-center justify-center gap-3">
            <Loader className="h-5 w-5 animate-spin text-yellow-400" aria-hidden="true" />
            <span>{partnerAccepted ? t("match.bothAccepted") : t("match.waitingFor", { name: partner.name })}</span>
          </div>
        ) : (
          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={onDecline}
              disabled={expired}
              data-testid="match-decline"
              className="flex h-14 min-w-[6.5rem] items-center justify-center gap-2 rounded-full border-2 border-black bg-gray-800 px-5 font-bold text-white shadow-[0_3px_0_#000] hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-5 w-5" aria-hidden="true" />
              {t("match.pass")}
            </button>
            <button
              type="button"
              onClick={onAccept}
              disabled={expired}
              data-testid="match-accept"
              className="flex h-14 flex-1 items-center justify-center gap-2 rounded-full border-2 border-black bg-yellow-400 px-5 text-lg font-bold text-black shadow-[0_4px_0_#000] hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check className="h-6 w-6" aria-hidden="true" />
              {t("match.accept")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
