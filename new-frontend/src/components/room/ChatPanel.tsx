import React, { useEffect, useRef, useState } from "react";
import { Send, X } from "lucide-react";
import { Button } from "@/components/retroui/Button";
import { Input } from "@/components/retroui/Input";
import { LIMITS } from "@/lib/protocol";
import type { ChatEntry } from "@/hooks/useSignaling";

interface ChatPanelProps {
  messages: ChatEntry[];
  partnerTyping: boolean;
  textOnly: boolean;
  isMobile: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
  /** Called on every edit with whether the input currently has text. */
  onTyping: (typing: boolean) => void;
}

const TypingDots: React.FC<{ size: "sm" | "md" }> = ({ size }) => {
  const dot = size === "sm" ? "w-1 h-1" : "w-2 h-2";
  return (
    <div className="flex space-x-1" aria-hidden="true">
      <div className={`${dot} bg-yellow-400 rounded-full animate-bounce`}></div>
      <div className={`${dot} bg-yellow-400 rounded-full animate-bounce`} style={{ animationDelay: "0.1s" }}></div>
      <div className={`${dot} bg-yellow-400 rounded-full animate-bounce`} style={{ animationDelay: "0.2s" }}></div>
    </div>
  );
};

export const PartnerTyping: React.FC = () => (
  <div className="flex items-center justify-center gap-2 text-yellow-400" role="status">
    <TypingDots size="md" />
    <span className="text-sm">Partner is typing...</span>
  </div>
);

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  partnerTyping,
  textOnly,
  isMobile,
  onClose,
  onSend,
  onTyping,
}) => {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Auto scroll to the newest message.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div
      className={`${
        textOnly
          ? "flex-1 bg-gray-800 border-l border-gray-700"
          : isMobile
            ? "fixed inset-0 z-50 bg-gray-800 border-gray-700"
            : "w-80 bg-gray-800 border-l border-gray-700"
      } flex flex-col`}
    >
      {/* Chat Header */}
      <div className="p-4 border-b border-gray-700 flex items-center justify-between">
        <h3 className="font-medium text-white">{textOnly ? "Text Chat" : "Chat"}</h3>
        <div className="flex items-center gap-2">
          {partnerTyping && !textOnly && (
            <span className="text-xs text-yellow-400 flex items-center gap-1" role="status">
              <TypingDots size="sm" />
              typing...
            </span>
          )}
          {isMobile && !textOnly && (
            <Button
              onClick={onClose}
              variant="outline"
              size="sm"
              aria-label="Close chat"
              className="bg-gray-700 border-gray-600 text-white hover:bg-gray-600"
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={listRef} className="flex-1 p-4 overflow-y-auto space-y-3" aria-live="polite">
        {messages.length === 0 ? (
          <p className="text-gray-400 text-center text-sm">Start a conversation! Say hello 👋</p>
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
                  className={`max-w-[85%] min-w-0 px-3 py-2 rounded-lg text-sm [overflow-wrap:anywhere] whitespace-pre-wrap ${
                    message.from === "me" ? "bg-yellow-500 text-black" : "bg-gray-700 text-white"
                  } ${message.delivery === "pending" ? "opacity-70" : ""}`}
                >
                  {message.text}
                </div>
                {message.delivery === "failed" && <span className="text-xs text-red-400 mt-1">Not delivered</span>}
              </div>
            ),
          )
        )}
      </div>

      {/* Chat Input */}
      <div className="p-4 border-t border-gray-700">
        <div className="flex gap-2">
          <Input
            type="text"
            placeholder="Type a message..."
            aria-label="Message"
            data-testid="chat-input"
            value={draft}
            maxLength={LIMITS.chatMax}
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
            className="flex-1 bg-gray-700 border-gray-600 text-white placeholder-gray-400 focus:border-yellow-500"
          />
          <Button
            onClick={send}
            disabled={!draft.trim()}
            size="sm"
            aria-label="Send message"
            data-testid="chat-send"
            className="bg-yellow-500 text-black hover:bg-yellow-400"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};
