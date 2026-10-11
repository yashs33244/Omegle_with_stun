import React from "react";
import { Loader, ShieldAlert, MonitorSmartphone, WifiOff } from "lucide-react";
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
  onRetry: () => void;
  onHome: () => void;
}

const Shell: React.FC<{ children: React.ReactNode; testId?: string }> = ({ children, testId }) => (
  <div
    className="w-full h-full min-h-[240px] bg-black flex items-center justify-center p-4"
    style={{ zIndex: 3 }}
    data-testid={testId}
  >
    <div className="text-center space-y-4">{children}</div>
  </div>
);

const ActionButton: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button type="button" onClick={onClick} className="retro-button">
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
  onRetry,
  onHome,
}) => {
  const { t } = useTranslation("room");
  if (status === "banned") {
    return (
      <Shell>
        <ShieldAlert className="w-16 h-16 text-red-400 mx-auto" />
        <div className="text-white space-y-2">
          <p className="text-xl font-medium">{t("waiting.bannedTitle")}</p>
          <p className="text-sm text-gray-300">{t("waiting.bannedBody")}</p>
        </div>
        <ActionButton onClick={onHome}>{t("waiting.backHome")}</ActionButton>
      </Shell>
    );
  }

  if (status === "replaced") {
    return (
      <Shell>
        <MonitorSmartphone className="w-16 h-16 text-yellow-400 mx-auto" />
        <div className="text-white space-y-2">
          <p className="text-xl font-medium">{t("waiting.replacedTitle")}</p>
          <p className="text-sm text-gray-300">{t("waiting.replacedBody")}</p>
        </div>
        <ActionButton onClick={onHome}>{t("waiting.backHome")}</ActionButton>
      </Shell>
    );
  }

  if (status === "error") {
    return (
      <Shell>
        <WifiOff className="w-16 h-16 text-red-400 mx-auto" />
        <div className="text-white space-y-2">
          <p className="text-xl font-medium">{t("waiting.errorTitle")}</p>
          {error && <p className="text-sm text-gray-300">{error}</p>}
        </div>
        <ActionButton onClick={onRetry}>{t("waiting.retry")}</ActionButton>
      </Shell>
    );
  }

  if (status === "connecting") {
    return (
      <Shell>
        <Loader className="w-16 h-16 text-yellow-400 animate-spin mx-auto" />
        <div className="text-white space-y-2">
          <p className="text-xl font-medium">{reconnecting ? t("waiting.reconnecting") : t("waiting.connecting")}</p>
          {reconnecting && (
            <p className="text-sm text-gray-300">{t("waiting.connectionLost")}</p>
          )}
          {error && <p className="text-sm text-orange-300">{error}</p>}
        </div>
      </Shell>
    );
  }

  return (
    <Shell testId="status-waiting">
      {photo ? (
        <div className="w-20 h-20 mx-auto rounded-full overflow-hidden border-4 border-yellow-500 animate-pulse">
          <img src={photo} alt={t("waiting.profileAlt")} className="w-full h-full object-cover" />
        </div>
      ) : (
        <Loader className="w-16 h-16 text-yellow-400 animate-spin mx-auto" />
      )}
      <div className="text-white space-y-2">
        {lastEndReason && (
          <p className="text-sm text-yellow-300" data-testid="end-reason" data-reason={lastEndReason}>
            {t(`waiting.endReason.${lastEndReason}`)}
          </p>
        )}
        <p className="text-xl font-medium">{t("waiting.looking")}</p>
        <p className="text-sm text-gray-300">{t("waiting.matchingTopics", { topics: formatTopics(topics) })}</p>
      </div>
    </Shell>
  );
};
