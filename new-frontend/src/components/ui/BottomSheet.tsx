/**
 * BottomSheet: the one modal surface for phones. Slides up from the bottom
 * with a drag handle; from the `md` breakpoint it becomes a centred dialog.
 * Built on Radix Dialog, which provides the focus trap, Escape, `aria-modal`,
 * scroll lock and the portal. Design: dark gray-900 panel, 2 px black border,
 * yellow primary actions live in the caller's `footer`.
 *
 * Props
 * - `open`, `onOpenChange(open)`: controlled. `false` arrives on Escape, a press
 *   on the backdrop, the close button and a drag down past the threshold.
 * - `title` (required, names the dialog), `hideTitle` keeps it screen-reader only.
 * - `description`: optional line under the title (also `aria-describedby`).
 * - `children`: the body; it scrolls when the content is taller than the sheet.
 * - `footer`: sticky slot at the bottom, padded above the home indicator.
 *   Put the primary button here.
 * - `modal` (default true): `false` drops the backdrop, focus trap and scroll
 *   lock so the page behind stays interactive (chat over a live video).
 * - `tone`: "dark" (default) or "light" panel.
 * - `className`, `data-testid`: applied to the panel (`role="dialog"`).
 * - `closeLabel`: accessible name of the X button (default: common "Close").
 * - `onEscapeKeyDown`, `onPointerDownOutside`, `onOpenAutoFocus`: Radix
 *   Content pass-throughs, e.g. to keep the sheet open while a dropdown
 *   inside it is the thing being dismissed.
 *
 * Layout: `max-h` is the visible viewport (`--app-height`) minus the top safe
 * area and a small margin; `--safe-bottom` pads the footer (or the body when
 * there is no footer).
 *
 * `useModalSheetOpen()` (./modalSheet) tells floating UI outside the sheet (the
 * Spark card) that a modal sheet is up: Radix sets `pointer-events: none` on the
 * body, so anything rendered above the sheet would look live but be inert.
 */
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { countModalSheet } from "./modalSheet";

type ContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>;

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  hideTitle?: boolean;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  modal?: boolean;
  tone?: "dark" | "light";
  className?: string;
  "data-testid"?: string;
  closeLabel?: string;
  onEscapeKeyDown?: ContentProps["onEscapeKeyDown"];
  onPointerDownOutside?: ContentProps["onPointerDownOutside"];
  onOpenAutoFocus?: ContentProps["onOpenAutoFocus"];
}

/** Drag the handle down this far (px) and the sheet closes. */
const DISMISS_DISTANCE = 80;

/** Pointer-drag state for the handle; translateY follows the finger, release decides. */
function useDragToDismiss(onDismiss: () => void) {
  const [offset, setOffset] = React.useState(0);
  const startY = React.useRef<number | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    startY.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (startY.current === null) return;
    setOffset(Math.max(0, e.clientY - startY.current));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (startY.current === null) return;
    const travelled = e.clientY - startY.current;
    startY.current = null;
    setOffset(0);
    if (travelled > DISMISS_DISTANCE) onDismiss();
  };
  const onPointerCancel = () => {
    startY.current = null;
    setOffset(0);
  };

  return { offset, handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } };
}

const TONE = {
  dark: {
    panel: "bg-gray-900 text-white border-black",
    muted: "text-gray-300",
    handle: "bg-gray-600",
    close: "text-gray-300 hover:text-white hover:bg-white/10",
    footer: "border-gray-800 bg-gray-900",
  },
  light: {
    panel: "bg-white text-black border-black",
    muted: "text-gray-600",
    handle: "bg-gray-300",
    close: "text-gray-600 hover:text-black hover:bg-black/5",
    footer: "border-gray-200 bg-white",
  },
} as const;

export const BottomSheet: React.FC<BottomSheetProps> = ({
  open,
  onOpenChange,
  title,
  hideTitle = false,
  description,
  children,
  footer,
  modal = true,
  tone = "dark",
  className,
  "data-testid": testId,
  closeLabel,
  onEscapeKeyDown,
  onPointerDownOutside,
  onOpenAutoFocus,
}) => {
  const { t } = useTranslation();
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  const { offset, handleProps } = useDragToDismiss(close);
  const styles = TONE[tone];
  const countsAsModal = open && modal;
  React.useEffect(() => {
    if (!countsAsModal) return;
    countModalSheet(1);
    return () => countModalSheet(-1);
  }, [countsAsModal]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <DialogPrimitive.Portal>
        {modal && (
          <DialogPrimitive.Overlay
            data-testid="sheet-backdrop"
            className="fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          />
        )}
        <DialogPrimitive.Content
          data-testid={testId}
          aria-modal={modal || undefined}
          onEscapeKeyDown={onEscapeKeyDown}
          onPointerDownOutside={onPointerDownOutside}
          onOpenAutoFocus={onOpenAutoFocus}
          {...(description ? {} : { "aria-describedby": undefined })}
          style={offset ? { transform: `translateY(${offset}px)`, transition: "none" } : undefined}
          className={cn(
            "fixed z-50 flex flex-col border-2 shadow-lg outline-none",
            "inset-x-0 bottom-0 rounded-t-2xl border-b-0 max-h-[calc(var(--app-height)-var(--safe-top)-2rem)]",
            "md:inset-auto md:left-1/2 md:top-1/2 md:w-full md:max-w-md md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border-b-2 md:max-h-[calc(var(--app-height)-4rem)]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=open]:slide-in-from-bottom-10 data-[state=closed]:slide-out-to-bottom-10 md:data-[state=open]:slide-in-from-bottom-0 md:data-[state=closed]:slide-out-to-bottom-0",
            styles.panel,
            className,
          )}
        >
          {/* Handle: visible on phones only, drags the sheet down to close it. */}
          <div
            {...handleProps}
            className="flex justify-center pt-2 pb-1 md:hidden touch-none cursor-grab active:cursor-grabbing"
            aria-hidden="true"
          >
            <span className={cn("h-1.5 w-10 rounded-full", styles.handle)} />
          </div>

          <div className="flex items-start gap-2 px-4 pt-2 md:pt-4">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className={cn("text-lg font-bold leading-tight", hideTitle && "sr-only")}>
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className={cn("mt-1 text-sm", styles.muted)}>
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              className={cn(
                "-mr-2 -mt-2 flex h-tap w-tap shrink-0 items-center justify-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400",
                styles.close,
              )}
              aria-label={closeLabel ?? t("close")}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>

          <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3", !footer && "pb-[max(var(--safe-bottom),1rem)]")}>
            {children}
          </div>

          {footer && (
            <div className={cn("shrink-0 border-t px-4 pt-3 pb-[max(var(--safe-bottom),0.75rem)]", styles.footer)}>
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};
