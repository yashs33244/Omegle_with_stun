import React from "react";
import { Hourglass, Loader, MonitorSmartphone, ShieldAlert, Users, WifiOff, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatTopics } from "@/lib/utils";
import type { MatchEndReason } from "@/lib/protocol";
import type { SignalingStatus } from "@/hooks/useSignaling";

interface WaitingPanelProps {
  status: SignalingStatus;
  reconnecting: boolean;
  lastEndReason: MatchEndReason | null;
  error: string | null;
  photo?: string;
  topics: readonly string[];
  /** How far the server widened the search: 0 topic + language, 1 language, 2 anyone. */
  relaxStep: number;
  /** People online, when the server shares the real count. */
  online: number | null;
  onRetry: () => void;
  /** Join the queue again after the server left us idle. */
  onSearch: () => void;
  /** Stop searching and go back to the start screen. */
  onHome: () => void;
}

const RELAX_HINT_KEYS = ["waiting.matchingTopics", "waiting.relaxLanguage", "waiting.relaxAnyone"] as const;

/** Full-screen overlay over the dimmed camera preview; the footer holds the one action. */
const Shell: React.FC<{ children: React.ReactNode; footer?: React.ReactNode; testId?: string }> = ({ children, footer, testId }) => (
  <div
    className="absolute inset-0 z-[12] flex flex-col items-center bg-black/65 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[calc(env(safe-area-inset-top)+5rem)] text-center text-white"
    data-testid={testId}
  >
    <div className="flex w-full max-w-sm flex-1 flex-col items-center justify-center space-y-5">{children}</div>
    {footer && <div className="flex w-full max-w-sm flex-col items-stretch gap-3 pt-6">{footer}</div>}
  </div>
);

const PrimaryButton: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button type="button" onClick={onClick} className="retro-button min-h-[3.5rem] text-lg">
    {children}
  </button>
);

export const WaitingPanel: React.FC<WaitingPanelProps> = ({
  status,
  reconnecting,
  lastEndReason,
  error,
  photo,
  topics,
  relaxStep,
  online,
  onRetry,
  onSearch,
  onHome,
}) => {
  const { t } = useTranslation("room");
  if (status === "banned") {
    return (
      <Shell footer={<PrimaryButton onClick={onHome}>{t("waiting.backHome")}</PrimaryButton>}>
        <ShieldAlert className="mx-auto h-16 w-16 text-red-400" aria-hidden="true" />
        <div className="space-y-2">
          <p className="text-xl font-semibold">{t("waiting.bannedTitle")}</p>
          <p className="text-sm text-gray-300">{t("waiting.bannedBody")}</p>
        </div>
      </Shell>
    );
  }

  if (status === "replaced") {
    return (
      <Shell footer={<PrimaryButton onClick={onHome}>{t("waiting.backHome")}</PrimaryButton>}>
        <MonitorSmartphone className="mx-auto h-16 w-16 text-yellow-400" aria-hidden="true" />
        <div className="space-y-2">
          <p className="text-xl font-semibold">{t("waiting.replacedTitle")}</p>
          <p className="text-sm text-gray-300">{t("waiting.replacedBody")}</p>
        </div>
      </Shell>
    );
  }

  if (status === "error") {
    return (
      <Shell footer={<PrimaryButton onClick={onRetry}>{t("waiting.retry")}</PrimaryButton>}>
        <WifiOff className="mx-auto h-16 w-16 text-red-400" aria-hidden="true" />
        <div className="space-y-2">
          <p className="text-xl font-semibold">{t("waiting.errorTitle")}</p>
          {error && <p className="text-sm text-gray-300">{error}</p>}
        </div>
      </Shell>
    );
  }

  if (status === "idle") {
    return (
      <Shell
        testId="status-idle"
        footer={
          <>
            <PrimaryButton onClick={onSearch}>{t("waiting.searchAgain")}</PrimaryButton>
            <button type="button" onClick={onHome} className="min-h-[2.75rem] text-sm font-medium text-gray-300 underline-offset-4 hover:underline">
              {t("waiting.backHome")}
            </button>
          </>
        }
      >
        <Hourglass className="mx-auto h-16 w-16 text-yellow-400" aria-hidden="true" />
        <div className="space-y-2">
          <p className="text-xl font-semibold">{t("waiting.endReason.accept-timeout")}</p>
          <p className="text-sm text-gray-300">{t("waiting.idleBody")}</p>
        </div>
      </Shell>
    );
  }

  if (status === "connecting") {
    return (
      <Shell>
        <Loader className="mx-auto h-16 w-16 animate-spin text-yellow-400" aria-hidden="true" />
        <div className="space-y-2">
          <p className="text-xl font-semibold">{reconnecting ? t("waiting.reconnecting") : t("waiting.connecting")}</p>
          {reconnecting && <p className="text-sm text-gray-300">{t("waiting.connectionLost")}</p>}
          {error && <p className="text-sm text-orange-300">{error}</p>}
        </div>
      </Shell>
    );
  }

  const hintKey = RELAX_HINT_KEYS[Math.min(relaxStep, RELAX_HINT_KEYS.length - 1)] ?? RELAX_HINT_KEYS[0];
  return (
    <Shell
      testId="status-waiting"
      footer={
        <button
          type="button"
          onClick={onHome}
          data-testid="cancel-search"
          className="flex min-h-[3.5rem] items-center justify-center gap-2 rounded-full border-2 border-black bg-gray-800/90 text-lg font-semibold text-white shadow-[0_3px_0_#000] hover:bg-gray-700"
        >
          <X className="h-5 w-5" aria-hidden="true" />
          {t("waiting.cancel")}
        </button>
      }
    >
      <div className="relative mx-auto h-24 w-24">
        <span className="absolute inset-0 animate-ping rounded-full bg-yellow-400/30 motion-reduce:animate-none" aria-hidden="true" />
        <span className="absolute -inset-2 animate-pulse rounded-full border-2 border-yellow-400/60 motion-reduce:animate-none" aria-hidden="true" />
        {photo ? (
          <img src={photo} alt={t("waiting.profileAlt")} className="relative h-24 w-24 rounded-full border-4 border-yellow-400 object-cover" />
        ) : (
          <span className="relative flex h-24 w-24 items-center justify-center rounded-full border-4 border-yellow-400 bg-gray-900">
            <Loader className="h-10 w-10 animate-spin text-yellow-400" aria-hidden="true" />
          </span>
        )}
      </div>
      <div className="space-y-2">
        {lastEndReason && (
          <p className="text-sm text-yellow-300" data-testid="end-reason" data-reason={lastEndReason}>
            {t(`waiting.endReason.${lastEndReason}`)}
          </p>
        )}
        <p className="text-2xl font-bold">{t("waiting.looking")}</p>
        <p className="text-sm text-gray-300" data-testid="relax-hint" data-step={relaxStep}>
          {t(hintKey, { topics: formatTopics(topics) })}
        </p>
      </div>
      {online !== null && (
        <p className="flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-sm text-gray-200" data-testid="online-count">
          <Users className="h-4 w-4 text-green-400" aria-hidden="true" />
          {t("waiting.online", { count: online })}
        </p>
      )}
    </Shell>
  );
};
