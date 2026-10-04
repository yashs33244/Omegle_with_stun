import React from "react";
import { Loader, ShieldAlert, MonitorSmartphone, WifiOff } from "lucide-react";
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

const END_REASON_TEXT: Record<MatchEndReason, string> = {
  declined: "You passed. Looking for someone else...",
  "partner-declined": "The other user declined the match. Looking for someone else...",
  timeout: "The match timed out. Looking for someone else...",
  skipped: "You skipped. Looking for someone new...",
  "partner-skipped": "Your chat partner skipped. Looking for someone new...",
  "partner-left": "Your chat partner has disconnected",
  reported: "User reported. Thank you for helping keep our community safe.",
  "partner-unavailable": "Your chat partner is no longer available.",
};

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
  if (status === "banned") {
    return (
      <Shell>
        <ShieldAlert className="w-16 h-16 text-red-400 mx-auto" />
        <div className="text-white space-y-2">
          <p className="text-xl font-medium">You have been temporarily restricted</p>
          <p className="text-sm text-gray-300">Several people reported this session. Please try again later.</p>
        </div>
        <ActionButton onClick={onHome}>Back to Home</ActionButton>
      </Shell>
    );
  }

  if (status === "replaced") {
    return (
      <Shell>
        <MonitorSmartphone className="w-16 h-16 text-yellow-400 mx-auto" />
        <div className="text-white space-y-2">
          <p className="text-xl font-medium">Chizzy is open in another tab</p>
          <p className="text-sm text-gray-300">This tab was disconnected. Keep chatting in the other one.</p>
        </div>
        <ActionButton onClick={onHome}>Back to Home</ActionButton>
      </Shell>
    );
  }

  if (status === "error") {
    return (
      <Shell>
        <WifiOff className="w-16 h-16 text-red-400 mx-auto" />
        <div className="text-white space-y-2">
          <p className="text-xl font-medium">Could not join the chat</p>
          {error && <p className="text-sm text-gray-300">{error}</p>}
        </div>
        <ActionButton onClick={onRetry}>Try Again</ActionButton>
      </Shell>
    );
  }

  if (status === "connecting") {
    return (
      <Shell>
        <Loader className="w-16 h-16 text-yellow-400 animate-spin mx-auto" />
        <div className="text-white space-y-2">
          <p className="text-xl font-medium">{reconnecting ? "Reconnecting..." : "Connecting..."}</p>
          {reconnecting && (
            <p className="text-sm text-gray-300">Lost the connection to the server. Your call has ended.</p>
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
          <img src={photo} alt="Your profile" className="w-full h-full object-cover" />
        </div>
      ) : (
        <Loader className="w-16 h-16 text-yellow-400 animate-spin mx-auto" />
      )}
      <div className="text-white space-y-2">
        {lastEndReason && <p className="text-sm text-yellow-300">{END_REASON_TEXT[lastEndReason]}</p>}
        <p className="text-xl font-medium">Looking for someone...</p>
        <p className="text-sm text-gray-300">Matching with users interested in: {formatTopics(topics)}</p>
      </div>
    </Shell>
  );
};
