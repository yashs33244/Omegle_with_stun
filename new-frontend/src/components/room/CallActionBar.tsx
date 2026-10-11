import React from "react";
import { Flag, MessageCircle, MessageSquareText, Mic, MicOff, SkipForward, Square, SwitchCamera } from "lucide-react";
import { useTranslation } from "react-i18next";

interface CallActionBarProps {
  onNext: () => void;
  onStop: () => void;
  chatOpen: boolean;
  unreadCount: number;
  onToggleChat: () => void;
  onReport: () => void;
  micEnabled: boolean;
  onToggleMic: () => void;
  textOnly: boolean;
  onToggleTextOnly: () => void;
  /** Phones only: switch between the front and back camera. */
  onFlipCamera?: () => void;
  frontCamera: boolean;
  /** Next and Stop only, while Instant mode is still connecting the call. */
  connecting?: boolean;
}

const ROUND =
  "relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 border-black text-white shadow-[0_3px_0_#000] transition-transform active:translate-y-0.5 active:shadow-none focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400";

const RoundButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: "dark" | "danger" | "active" }
> = ({ label, tone = "dark", className = "", children, ...props }) => {
  const toneClass =
    tone === "danger" ? "bg-red-600 hover:bg-red-500" : tone === "active" ? "bg-yellow-400 text-black hover:bg-yellow-300" : "bg-gray-800/90 hover:bg-gray-700";
  return (
    <button type="button" aria-label={label} title={label} className={`${ROUND} ${toneClass} ${className}`} {...props}>
      {children}
    </button>
  );
};

/**
 * The one thumb-reachable control strip of the call. Phones (portrait): two
 * rows pinned over the bottom of the video, above the home indicator.
 * Phones (landscape): a rail on the right edge. Desktop: one row under the
 * video. Icon buttons are 56 px; Next is the only wide, yellow one.
 */
export const CallActionBar = React.forwardRef<HTMLDivElement, CallActionBarProps>(
  (
    {
      onNext,
      onStop,
      chatOpen,
      unreadCount,
      onToggleChat,
      onReport,
      micEnabled,
      onToggleMic,
      textOnly,
      onToggleTextOnly,
      onFlipCamera,
      frontCamera,
      connecting = false,
    },
    ref,
  ) => {
    const { t } = useTranslation(["room", "safety"]);

    return (
      <div
        ref={ref}
        data-testid="call-actions"
        className="absolute inset-x-0 bottom-0 z-[35] flex flex-col items-center gap-3 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-6 max-lg:landscape:inset-x-auto max-lg:landscape:inset-y-0 max-lg:landscape:right-0 max-lg:landscape:w-auto max-lg:landscape:flex-row max-lg:landscape:items-center max-lg:landscape:justify-center max-lg:landscape:gap-3 max-lg:landscape:bg-gradient-to-l max-lg:landscape:py-2 max-lg:landscape:pl-6 max-lg:landscape:pr-[max(0.75rem,env(safe-area-inset-right))] lg:static lg:flex-row lg:justify-center lg:gap-6 lg:border-t lg:border-gray-800 lg:bg-gray-900 lg:px-6 lg:py-4"
      >
        {!connecting && (
          <div className="flex items-center justify-center gap-2 max-lg:landscape:flex-col lg:gap-3">
            <RoundButton
              label={micEnabled ? t("mic.mute") : t("mic.unmute")}
              aria-pressed={!micEnabled}
              data-testid="mic-toggle"
              tone={micEnabled ? "dark" : "danger"}
              onClick={onToggleMic}
            >
              {micEnabled ? <Mic className="h-6 w-6" aria-hidden="true" /> : <MicOff className="h-6 w-6" aria-hidden="true" />}
            </RoundButton>
            <RoundButton
              label={t("textOnly.toggle")}
              aria-pressed={textOnly}
              data-testid="text-only-toggle"
              tone={textOnly ? "active" : "dark"}
              onClick={onToggleTextOnly}
            >
              <MessageSquareText className="h-6 w-6" aria-hidden="true" />
            </RoundButton>
            {onFlipCamera && !textOnly && (
              <RoundButton
                label={frontCamera ? t("camera.switchToBack") : t("camera.switchToFront")}
                data-testid="flip-camera"
                onClick={onFlipCamera}
              >
                <SwitchCamera className="h-6 w-6" aria-hidden="true" />
              </RoundButton>
            )}
            {/*
              Reserved slots for the SparkCaptions lane: <SparkButton roomId={...} /> from
              src/spark/index.ts and <CaptionsToggle /> from src/captions/index.ts mount here,
              after the camera flip and before Report. Both are 56 px round buttons.
            */}
            <RoundButton label={t("reportButton.label", { ns: "safety" })} data-testid="report-button" onClick={onReport}>
              <Flag className="h-6 w-6" aria-hidden="true" />
            </RoundButton>
          </div>
        )}

        <div className="flex w-full max-w-sm items-center justify-center gap-3 max-lg:landscape:w-auto max-lg:landscape:flex-col lg:w-auto">
          <RoundButton label={t("actions.stop")} data-testid="stop-button" tone="danger" onClick={onStop}>
            <Square className="h-5 w-5 fill-current" aria-hidden="true" />
          </RoundButton>
          <button
            type="button"
            onClick={onNext}
            data-testid="next-button"
            aria-keyshortcuts="Escape ArrowRight"
            title={t("next.title")}
            className="flex h-14 min-w-[8.5rem] flex-1 items-center justify-center gap-2 rounded-full border-2 border-black bg-yellow-400 px-6 text-lg font-bold text-black shadow-[0_4px_0_#000] transition-transform hover:bg-yellow-300 active:translate-y-0.5 active:shadow-none focus:outline-none focus-visible:ring-2 focus-visible:ring-white max-lg:landscape:min-w-0 max-lg:landscape:w-14 max-lg:landscape:px-0 lg:flex-none lg:px-8"
          >
            <SkipForward className="h-6 w-6" aria-hidden="true" />
            <span className="max-lg:landscape:sr-only">{t("next.label")}</span>
          </button>
          {!connecting && (
            <RoundButton
              label={t("chat.toggle")}
              aria-pressed={chatOpen}
              data-testid="chat-toggle"
              tone={chatOpen ? "active" : "dark"}
              onClick={onToggleChat}
            >
              <MessageCircle className="h-6 w-6" aria-hidden="true" />
              {unreadCount > 0 && (
                <span
                  data-testid="chat-unread"
                  className="absolute -right-1 -top-1 flex h-6 min-w-[1.5rem] items-center justify-center rounded-full border-2 border-black bg-red-500 px-1 text-xs font-bold text-white"
                >
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </RoundButton>
          )}
        </div>
      </div>
    );
  },
);

CallActionBar.displayName = "CallActionBar";
