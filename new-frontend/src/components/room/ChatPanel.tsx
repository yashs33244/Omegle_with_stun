import React, { useEffect, useRef, useState } from "react";
import { Send, ShieldAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/retroui/Button";
import { Input } from "@/components/retroui/Input";
import { LIMITS } from "@/lib/protocol";
import type { ChatEntry } from "@/hooks/useSignaling";
import { RedactedText } from "@/components/safety/RedactedText";

/**
 * The chat itself: header, message list, input. Fills whatever box the
 * parent gives it (the desktop side column or the phone ChatSheet).
 */
interface ChatPanelProps {
  messages: ChatEntry[];
  partnerTyping: boolean;
  textOnly: boolean;
  /** Shows a close button in the header when given. */
  onClose?: () => void;
  onSend: (text: string) => void;
  /** Called on every edit with whether the input currently has text. */
  onTyping: (typing: boolean) => void;
  /** Message ids the server's chat guard redacted. */
  redactedIds?: ReadonlySet<string>;
  /** Inline safety notice after a safety:nudge in this call. */
  safetyNotice?: string | null;
}

const TypingDots: React.FC<{ size: "sm" | "md" }> = ({ size }) => {
  const dot = size === "sm" ? "w-1 h-1" : "w-2 h-2";
  return (
    <div className="flex space-x-1" aria-hidden="true">
      <div className={`${dot} bg-yellow-400 rounded-full animate-bounce motion-reduce:animate-none`}></div>
      <div className={`${dot} bg-yellow-400 rounded-full animate-bounce motion-reduce:animate-none`} style={{ animationDelay: "0.1s" }}></div>
      <div className={`${dot} bg-yellow-400 rounded-full animate-bounce motion-reduce:animate-none`} style={{ animationDelay: "0.2s" }}></div>
    </div>
  );
};

export const PartnerTyping: React.FC = () => {
  const { t } = useTranslation("room");
  return (
    <div className="flex items-center justify-center gap-2 text-yellow-400" role="status" data-testid="partner-typing">
      <TypingDots size="md" />
      <span className="text-sm">{t("chat.partnerTyping")}</span>
    </div>
  );
};

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  partnerTyping,
  textOnly,
  onClose,
  onSend,
  onTyping,
  redactedIds,
  safetyNotice,
}) => {
  const { t } = useTranslation("room");
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Auto scroll to the newest message.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length, safetyNotice]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-800 text-white">
      {/* Chat Header */}
      <div className="flex items-center justify-between gap-2 border-b border-gray-700 px-4 py-2">
        <h3 className="font-medium text-white">{textOnly ? t("chat.textTitle") : t("chat.title")}</h3>
        <div className="flex items-center gap-2">
          {partnerTyping && !textOnly && (
            <span className="text-xs text-yellow-400 flex items-center gap-1" role="status" data-testid="partner-typing">
              <TypingDots size="sm" />
              {t("chat.typing")}
            </span>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t("chat.close")}
              data-testid="chat-close"
              className="flex h-11 w-11 items-center justify-center rounded-full text-gray-300 hover:bg-gray-700 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={listRef} className="flex-1 p-4 overflow-y-auto space-y-3" aria-live="polite">
        {messages.length === 0 ? (
          <p className="text-gray-400 text-center text-sm">{t("chat.empty")}</p>
        ) : (
          messages.map((message) =>
            message.from === "system" ? (
              <p key={message.id} className="text-center text-xs text-yellow-300">
                {message.text}
              </p>
            ) : (
              <div
                key={message.id}
                className={`flex flex-col ${message.from === "me" ? "items-end" : "items-start"}`}
              >
                <div
                  data-testid="chat-message"
                  data-from={message.from}
                  data-delivery={message.delivery}
                  className={`max-w-[85%] min-w-0 px-3 py-2 rounded-lg text-sm [overflow-wrap:anywhere] whitespace-pre-wrap ${
                    message.from === "me" ? "bg-yellow-500 text-black" : "bg-gray-700 text-white"
                  } ${message.delivery === "pending" ? "opacity-70" : ""}`}
                >
                  {redactedIds?.has(message.id) && message.from === "partner" ? (
                    <RedactedText text={message.text} />
                  ) : (
                    message.text
                  )}
                </div>
                {redactedIds?.has(message.id) && (
                  <span className="text-xs text-gray-400 mt-1" data-testid="redaction-note">
                    {message.from === "me" ? t("chat.redactedMine") : t("chat.redactedTheirs")}
                  </span>
                )}
                {message.delivery === "failed" && <span className="text-xs text-red-400 mt-1">{t("chat.notDelivered")}</span>}
              </div>
            ),
          )
        )}
        {safetyNotice && (
          <p
            role="note"
            data-testid="chat-safety-notice"
            className="flex items-start gap-2 rounded-lg border border-yellow-500/60 bg-yellow-500/10 p-2 text-xs text-yellow-200"
          >
            <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{safetyNotice}</span>
          </p>
        )}
      </div>

      {/* Chat Input */}
      <div className="border-t border-gray-700 p-3">
        <div className="flex items-center gap-2">
          <Input
            type="text"
            placeholder={t("chat.placeholder")}
            aria-label={t("chat.inputLabel")}
            data-testid="chat-input"
            value={draft}
            maxLength={LIMITS.chatMax}
            enterKeyHint="send"
            autoComplete="off"
            onChange={(e) => {
              setDraft(e.target.value);
              onTyping(e.target.value.trim().length > 0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            className="h-11 flex-1 bg-gray-700 border-gray-600 text-base text-white placeholder-gray-400 focus:border-yellow-500"
          />
          <Button
            onClick={send}
            disabled={!draft.trim()}
            size="icon"
            aria-label={t("chat.send")}
            data-testid="chat-send"
            className="h-11 w-11 shrink-0 justify-center rounded-full bg-yellow-400 text-black hover:bg-yellow-300 disabled:opacity-50"
          >
            <Send className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
};
