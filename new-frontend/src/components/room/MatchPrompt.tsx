import React, { useEffect, useState } from "react";
import { Check, Heart, Loader, UserRound, X } from "lucide-react";
import { getCountryByCode } from "@/lib/data";
import { formatTopics } from "@/lib/utils";
import type { PublicProfile } from "@/lib/protocol";
import { secondsLeft } from "@/hooks/useSignaling";

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
  const remaining = useSecondsLeft(expiresAt);
  const country = getCountryByCode(partner.country);

  return (
    <div className="w-full h-full bg-black flex items-center justify-center relative" style={{ zIndex: 3 }}>
      {partner.photo?.startsWith("data:image/") ? (
        <img
          src={partner.photo}
          alt={`${partner.name}'s photo`}
          className="w-full h-full object-cover"
          style={{ transform: "scaleX(-1)" }}
        />
      ) : (
        <div className="w-full h-full bg-gray-800 flex items-center justify-center">
          <UserRound className="w-32 h-32 text-gray-400" />
        </div>
      )}

      {/* Timer countdown */}
      {remaining !== null && remaining > 0 && (
        <div className="timer-text" aria-live="polite">
          {remaining}s
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
            <h3 className="text-2xl font-bold">Someone wants to chat!</h3>
            <p className="text-gray-300">
              {partner.name}
              {country && ` from ${country.name}`}
            </p>
            <p className="text-sm text-gray-400">Interested in: {formatTopics(partner.topics)}</p>
            {isFriend && (
              <p className="text-sm text-pink-400 flex items-center justify-center gap-1">
                <Heart className="w-4 h-4" /> You are friends
              </p>
            )}
            {partnerAccepted && !accepted && (
              <div className="bg-green-500 bg-opacity-20 border border-green-500 rounded-lg p-2 mt-3">
                <p className="text-green-400 text-sm">
                  ✅ {partner.name} has accepted! Waiting for your response...
                </p>
              </div>
            )}
          </div>

          {accepted ? (
            <div className="flex items-center justify-center gap-3 text-white">
              <Loader className="w-5 h-5 text-yellow-400 animate-spin" />
              <span>
                {partnerAccepted
                  ? "Both users accepted! Setting up video call..."
                  : `Waiting for ${partner.name} to accept...`}
              </span>
            </div>
          ) : (
            <div className="flex gap-4 justify-center">
              <button
                type="button"
                onClick={onDecline}
                data-testid="match-decline"
                className="retro-button bg-red-500 border-red-600 text-white hover:bg-red-400"
              >
                <X className="w-5 h-5 inline mr-2" />
                Pass
              </button>
              <button
                type="button"
                onClick={onAccept}
                data-testid="match-accept"
                className="retro-button bg-green-500 border-green-600 text-white hover:bg-green-400"
              >
                <Check className="w-5 h-5 inline mr-2" />
                Accept
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
