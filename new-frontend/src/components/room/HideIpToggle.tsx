import React, { useId } from "react";
import { Lock, LockOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

interface HideIpToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Extra line under the description, e.g. when a change applies. */
  note?: string;
  tone?: "dark" | "light";
}

/** "Hide my IP": relay-only connections. The copy says what it does not hide. */
export const HideIpToggle: React.FC<HideIpToggleProps> = ({ checked, onChange, note, tone = "dark" }) => {
  const { t } = useTranslation("room");
  const descriptionId = useId();
  const muted = tone === "dark" ? "text-gray-300" : "text-gray-600";
  return (
    <div className="flex items-start gap-2" data-testid="hide-ip">
      {/* The switch is drawn 40x24 but the button around it is a 44px tap target. */}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={descriptionId}
        data-testid="hide-ip-toggle"
        onClick={() => onChange(!checked)}
        className="-mt-2.5 -ml-1 flex min-h-tap min-w-tap shrink-0 items-center justify-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400"
      >
        <span
          aria-hidden="true"
          className={`relative block w-10 h-6 rounded-full border-2 border-black transition-colors ${
            checked ? "bg-green-500" : "bg-gray-500"
          }`}
        >
          <span
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${checked ? "left-[1.1rem]" : "left-0.5"}`}
          />
        </span>
        <span className="sr-only">{t("hideIp.label")}</span>
      </button>
      <div className="min-w-0">
        <p className="text-sm font-medium flex items-center gap-1">
          {checked ? <Lock className="w-4 h-4 text-green-400" aria-hidden="true" /> : <LockOpen className="w-4 h-4" aria-hidden="true" />}
          {t("hideIp.label")}
        </p>
        <p id={descriptionId} className={`text-xs ${muted}`}>
          {t("hideIp.description")}
        </p>
        {note && <p className={`text-xs ${muted}`}>{note}</p>}
      </div>
    </div>
  );
};
