/**
 * StickyBar: a bar that stays at the bottom (or top) of the viewport while its
 * parent is in view, then takes its place in the flow. Use it for the one
 * primary action of a screen so it is reachable without scrolling; content
 * after it (the footer) is still reachable by scrolling.
 *
 * Props
 * - `position`: "bottom" (default) or "top".
 * - `tone`: "dark" (default: gray-900 with a black top border), "glass"
 *   (translucent black with blur, for use over video) or "light" (white).
 * - `className`: extra classes; `data-testid`.
 *
 * The bottom variant pads for the home indicator (`--safe-bottom`), the top
 * variant for the status bar (`--safe-top`). The parent must not clip
 * overflow (sticky positioning needs the page to be the scroll container).
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export interface StickyBarProps {
  children: React.ReactNode;
  position?: "bottom" | "top";
  tone?: "dark" | "glass" | "light";
  className?: string;
  "data-testid"?: string;
}

const TONE = {
  dark: "bg-gray-900 text-white border-black",
  glass: "bg-black/70 text-white border-black backdrop-blur-sm",
  light: "bg-white text-black border-gray-200",
} as const;

export const StickyBar: React.FC<StickyBarProps> = ({
  children,
  position = "bottom",
  tone = "dark",
  className,
  "data-testid": testId,
}) => (
  <div
    data-testid={testId}
    className={cn(
      "sticky z-40 px-4",
      position === "bottom"
        ? "bottom-0 border-t-2 pt-3 pb-[max(var(--safe-bottom),0.75rem)]"
        : "top-0 border-b-2 pb-2 pt-[max(var(--safe-top),0.5rem)]",
      TONE[tone],
      className,
    )}
  >
    {children}
  </div>
);
