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
 *   `aria-checked`) or "group" (segments are buttons with `aria-pressed`).
 * - `size`: "md" (default, 44 px) or "sm" (36 px, desktop-only contexts).
 * - `tone`: "dark" (default) or "light" idle text.
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

const IDLE = {
  dark: "text-white hover:bg-white/10",
  light: "text-gray-700 hover:bg-black/5",
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

  // Arrow keys move between segments like a native radio group.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!radio) return;
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const index = options.findIndex((o) => o.value === value);
    const next = options[(index + step + options.length) % options.length];
    if (next) {
      onChange(next.value);
      const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>("button");
      buttons[(index + step + options.length) % options.length]?.focus();
    }
  };

  return (
    <div
      role={role}
      aria-label={ariaLabel}
      data-testid={testId}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex rounded-xl border-2 border-black bg-black/60 p-1",
        fullWidth && "flex w-full",
        className,
      )}
    >
      {options.map(({ value: option, label, icon: Icon, testId: optionTestId, lang, ariaLabel: optionAriaLabel }) => {
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
            tabIndex={radio && !selected ? -1 : 0}
            data-testid={optionTestId}
            onClick={() => onChange(option)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-lg font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400",
              SIZE[size],
              fullWidth && "flex-1",
              selected ? "bg-yellow-400 text-black" : IDLE[tone],
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
