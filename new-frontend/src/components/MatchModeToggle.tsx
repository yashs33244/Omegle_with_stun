import React from "react";
import { Eye, Zap } from "lucide-react";
import type { MatchMode } from "@/lib/protocol";

const OPTIONS: Array<{ mode: MatchMode; label: string; hint: string; Icon: typeof Zap }> = [
  { mode: "instant", label: "Instant", hint: "The call starts right away, video blurred until it is checked.", Icon: Zap },
  { mode: "preview", label: "Preview", hint: "See their name and photo first, then accept or pass.", Icon: Eye },
];

/** Instant / Preview segmented control on the start screen. */
export const MatchModeToggle: React.FC<{ mode: MatchMode; onChange: (mode: MatchMode) => void }> = ({ mode, onChange }) => {
  const hint = OPTIONS.find((o) => o.mode === mode)?.hint;
  return (
    <div className="space-y-1">
      <div role="radiogroup" aria-label="Match mode" className="inline-flex rounded-lg border-2 border-black bg-black bg-opacity-60 p-1">
        {OPTIONS.map(({ mode: value, label, Icon }) => {
          const selected = value === mode;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              data-testid={`mode-${value}`}
              onClick={() => onChange(value)}
              className={`flex items-center gap-1 px-4 py-1.5 rounded-md text-sm font-bold transition-colors ${
                selected ? "bg-yellow-500 text-black" : "text-white hover:bg-white hover:bg-opacity-10"
              }`}
            >
              <Icon className="w-4 h-4" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>
      {hint && <p className="text-xs text-gray-200">{hint}</p>}
    </div>
  );
};
