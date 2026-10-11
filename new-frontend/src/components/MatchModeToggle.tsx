import React from "react";
import { Eye, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Segmented } from "@/components/ui/Segmented";
import type { MatchMode } from "@/lib/protocol";

type ModeKey = "matchMode.instant" | "matchMode.preview";
type HintKey = "matchMode.instantHint" | "matchMode.previewHint";

const OPTIONS: ReadonlyArray<{ mode: MatchMode; label: ModeKey; hint: HintKey; Icon: typeof Zap }> = [
  { mode: "instant", label: "matchMode.instant", hint: "matchMode.instantHint", Icon: Zap },
  { mode: "preview", label: "matchMode.preview", hint: "matchMode.previewHint", Icon: Eye },
];

/** Instant / Preview segmented control on the start screen, with a one-line hint for the chosen mode. */
export const MatchModeToggle: React.FC<{ mode: MatchMode; onChange: (mode: MatchMode) => void; className?: string }> = ({
  mode,
  onChange,
  className,
}) => {
  const { t } = useTranslation("room");
  const hint = OPTIONS.find((o) => o.mode === mode)?.hint;
  return (
    <div className={className}>
      <Segmented<MatchMode>
        aria-label={t("matchMode.label")}
        value={mode}
        onChange={onChange}
        fullWidth
        options={OPTIONS.map(({ mode: value, label, Icon }) => ({
          value,
          label: t(label),
          icon: Icon,
          testId: `mode-${value}`,
        }))}
      />
      {hint && <p className="mt-1.5 text-xs text-gray-300 text-center">{t(hint)}</p>}
    </div>
  );
};
