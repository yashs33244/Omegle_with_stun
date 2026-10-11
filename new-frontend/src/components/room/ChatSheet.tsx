import React, { useEffect, useRef, type CSSProperties, type PointerEvent } from "react";
import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import type { ChatEntry } from "@/hooks/useSignaling";

interface ChatSheetProps {
  open: boolean;
  /** Text-only mode keeps the sheet up: no close, no swipe down. */
  dismissable: boolean;
  /** Landscape phones: a side panel on the left instead of a bottom sheet. */
  landscape: boolean;
  /** Height of the action bar the sheet sits on top of (portrait). */
  bottomOffset: number;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

/** Swipe-down distance on the handle that closes the sheet. */
const DISMISS_DRAG_PX = 72;
/** Room kept free above the sheet when the keyboard is up, so the top bar stays readable. */
const KEYBOARD_HEADROOM_PX = 56;

/**
 * Non-modal chat sheet over the video on phones. Sits above the action bar,
 * follows the on-screen keyboard (visualViewport), and leaves the video and
 * its controls interactive. On desktop the chat is a side column instead.
 *
 * Chrome only: swap for the shared `BottomSheet` (modal={false}) once it
 * exists; the content is the ChatPanel passed as children.
 */
export const ChatSheet: React.FC<ChatSheetProps> = ({ open, dismissable, landscape, bottomOffset, title, onClose, children }) => {
  const { t } = useTranslation("room");
  const keyboard = useKeyboardInset(open && !landscape);
  const dragStartY = useRef<number | null>(null);

  if (!open) return null;

  const keyboardUp = keyboard.inset > 0;
  const style: CSSProperties = landscape
    ? { bottom: keyboard.inset }
    : {
        bottom: keyboardUp ? keyboard.inset : bottomOffset,
        maxHeight: keyboardUp && dismissable ? Math.max(200, keyboard.visibleHeight - KEYBOARD_HEADROOM_PX) : undefined,
        // Text-only while typing: take the band above too, so the list keeps some height.
        top: keyboardUp && !dismissable ? KEYBOARD_HEADROOM_PX : undefined,
      };

  const onHandleDown = (e: PointerEvent<HTMLButtonElement>) => {
    dragStartY.current = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onHandleUp = (e: PointerEvent<HTMLButtonElement>) => {
    const start = dragStartY.current;
    dragStartY.current = null;
    if (start !== null && e.clientY - start > DISMISS_DRAG_PX) onClose();
  };

  return (
    <section
      aria-label={title}
      data-testid="chat-sheet"
      style={style}
      className={`fixed z-[45] flex flex-col overflow-hidden border-black bg-gray-800 shadow-[0_-4px_0_#000] ${
        landscape
          ? "left-0 top-0 w-[min(50vw,28rem)] border-r-2 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
          : dismissable
            ? "inset-x-0 h-[min(60dvh,32rem)] rounded-t-2xl border-t-2"
            : // Text-only: anchored under the band where TextOnlyPanel shows "Switch to Video".
              "inset-x-0 top-[calc(env(safe-area-inset-top)+15rem)] rounded-t-2xl border-t-2"
      }`}
    >
      {dismissable && !landscape && (
        <button
          type="button"
          aria-label={t("chat.close")}
          onClick={onClose}
          onPointerDown={onHandleDown}
          onPointerUp={onHandleUp}
          onPointerCancel={() => (dragStartY.current = null)}
          className="flex h-6 w-full shrink-0 touch-none items-center justify-center"
        >
          <span className="h-1.5 w-12 rounded-full bg-gray-500" aria-hidden="true" />
        </button>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
};

interface ChatToastProps {
  message: ChatEntry;
  partnerName: string;
  onOpen: () => void;
  onDismiss: () => void;
}

const TOAST_TTL_MS = 4_000;

/** A partner message that arrived while the chat was closed; tap to open the chat. */
export const ChatToast: React.FC<ChatToastProps> = ({ message, partnerName, onOpen, onDismiss }) => {
  const { t } = useTranslation("room");
  useEffect(() => {
    const timer = setTimeout(onDismiss, TOAST_TTL_MS);
    return () => clearTimeout(timer);
  }, [message.id, onDismiss]);

  return (
    // Phones: left of the local picture-in-picture column (and the landscape rail); desktop: centred.
    <div
      className="pointer-events-none fixed left-3 right-[7.5rem] z-[40] flex justify-center max-lg:landscape:right-auto max-lg:landscape:w-[min(28rem,50vw)] lg:inset-x-0 lg:px-4"
      style={{ top: "calc(env(safe-area-inset-top) + 4.5rem)" }}
    >
      <button
        type="button"
        onClick={onOpen}
        data-testid="chat-toast"
        aria-label={t("chat.openFrom", { name: partnerName })}
        className="pointer-events-auto flex max-w-md items-start gap-3 rounded-xl border-2 border-black bg-gray-900/95 px-4 py-3 text-left text-white shadow-[0_4px_0_#000]"
      >
        <MessageCircle className="mt-0.5 h-5 w-5 shrink-0 text-yellow-400" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-yellow-300">{partnerName}</span>
          <span className="line-clamp-2 break-words text-sm">{message.text}</span>
        </span>
      </button>
    </div>
  );
};
