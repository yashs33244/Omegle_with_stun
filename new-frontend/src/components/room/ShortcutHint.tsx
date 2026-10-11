import React, { useEffect, useState } from "react";
import { Keyboard, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export const SHORTCUT_HINT_KEY = "chizzy.shortcutHintSeen";
const HINT_TTL_MS = 10_000;

function hasSeenHint(): boolean {
  try {
    return localStorage.getItem(SHORTCUT_HINT_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * Desktop only: tells first-time callers that Esc or the right arrow means
 * Next. Shown once per device, above the action bar, and goes away by itself.
 */
export const ShortcutHint: React.FC<{ active: boolean }> = ({ active }) => {
  const { t } = useTranslation("room");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active || hasSeenHint()) return;
    setVisible(true);
    try {
      localStorage.setItem(SHORTCUT_HINT_KEY, "1");
    } catch {
      // Private mode: the hint simply shows again next time.
    }
    const timer = setTimeout(() => setVisible(false), HINT_TTL_MS);
    return () => clearTimeout(timer);
  }, [active]);

  if (!visible || !active) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-[34] hidden justify-center lg:flex" data-testid="shortcut-hint">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border-2 border-black bg-gray-900/95 py-1.5 pl-3 pr-1 text-sm text-white shadow-[0_3px_0_#000]">
        <Keyboard className="h-4 w-4 text-yellow-400" aria-hidden="true" />
        <span>{t("shortcuts.hint")}</span>
        <button
          type="button"
          onClick={() => setVisible(false)}
          aria-label={t("shortcuts.dismiss")}
          className="flex h-8 w-8 items-center justify-center rounded-full text-gray-300 hover:bg-gray-700 hover:text-white"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
