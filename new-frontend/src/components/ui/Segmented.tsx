/**
 * Segmented: a row of 2-4 exclusive options (Instant | Preview, EN | हिन्दी).
 * Retro chrome: 2 px black border, the selected segment is yellow-400.
 * Every segment is at least 44 px tall.
 *
 * Props
 * - `options`: `{ value, label, icon?, testId?, lang?, ariaLabel? }[]`.
 *   `icon` is a lucide component; `lang` marks a label in another language;
 *   `ariaLabel` replaces the visible label for screen readers.
 * - `value`, `onChange(value)`: controlled.
 * - `aria-label`: names the group.
 * - `role`: "radiogroup" (default; segments are `role="radio"` with
 *   `aria-checked`, a roving tabindex and arrow/Home/End keys) or "group"
 *   (segments are buttons with `aria-pressed`).
 * - `size`: "md" (default, 44 px) or "sm" (36 px, desktop-only contexts).
 * - `tone`: "dark" (default: translucent black group, white idle text) or
 *   "light" (gray-100 group, gray-700 idle text) for white surfaces.
 * - `fullWidth`: segments share the row equally (phones).
 * - `className`, `data-testid`: on the group element.
 */
import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: LucideIcon;
  testId?: string;
  lang?: string;
  ariaLabel?: string;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
  role?: "radiogroup" | "group";
  size?: "md" | "sm";
  tone?: "dark" | "light";
  fullWidth?: boolean;
  className?: string;
  "data-testid"?: string;
}

/** Group background and idle segment text per tone; the selected segment is always yellow-400 on black. */
const TONE = {
  dark: { group: "bg-black/60", idle: "text-white hover:bg-white/10", ring: "focus-visible:ring-offset-black" },
  light: { group: "bg-gray-100", idle: "text-gray-700 hover:bg-black/5", ring: "focus-visible:ring-offset-gray-100" },
} as const;

const SIZE = {
  md: "min-h-tap px-4 text-sm",
  sm: "min-h-9 px-3 text-xs",
} as const;

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  role = "radiogroup",
  size = "md",
  tone = "dark",
  fullWidth = false,
  className,
  "data-testid": testId,
}: SegmentedProps<T>) {
  const radio = role === "radiogroup";

  // Arrow keys move between segments like a native radio group; Home/End jump to the ends.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!radio) return;
    const index = Math.max(0, options.findIndex((o) => o.value === value));
    const last = options.length - 1;
    let target: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        target = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        target = index === 0 ? last : index - 1;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    const next = options[target];
    if (!next) return;
    onChange(next.value);
    e.currentTarget.querySelectorAll<HTMLButtonElement>("button")[target]?.focus();
  };
  // Roving tabindex: only the checked segment is in the tab order (the first one when nothing is checked yet).
  const selectedIndex = options.findIndex((o) => o.value === value);
  const tabStop = selectedIndex === -1 ? 0 : selectedIndex;

  return (
    <div
      role={role}
      aria-label={ariaLabel}
      data-testid={testId}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex rounded-xl border-2 border-black p-1",
        TONE[tone].group,
        fullWidth && "flex w-full",
        className,
      )}
    >
      {options.map(({ value: option, label, icon: Icon, testId: optionTestId, lang, ariaLabel: optionAriaLabel }, i) => {
        const selected = option === value;
        return (
          <button
            key={option}
            type="button"
            lang={lang}
            role={radio ? "radio" : undefined}
            aria-checked={radio ? selected : undefined}
            aria-pressed={radio ? undefined : selected}
            aria-label={optionAriaLabel}
            tabIndex={radio && i !== tabStop ? -1 : 0}
            data-testid={optionTestId}
            onClick={() => onChange(option)}
            className={cn(
              "relative flex items-center justify-center gap-1.5 rounded-lg font-bold transition-colors motion-reduce:transition-none focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2",
              TONE[tone].ring,
              SIZE[size],
              fullWidth && "flex-1",
              selected ? "bg-yellow-400 text-black" : TONE[tone].idle,
            )}
          >
            {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
            {label}
          </button>
        );
      })}
    </div>
  );
}
