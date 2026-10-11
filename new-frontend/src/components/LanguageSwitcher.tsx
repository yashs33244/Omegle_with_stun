import { useTranslation } from "react-i18next";
import { LANGUAGES, currentLang, setLanguage } from "@/lib/i18n";

/** EN / हिन्दी toggle. Shown in the footer and in chat settings. */
export const LanguageSwitcher: React.FC<{ tone?: "dark" | "light"; className?: string }> = ({
  tone = "dark",
  className = "",
}) => {
  const { t } = useTranslation();
  const active = currentLang();
  const activeClass = tone === "dark" ? "bg-yellow-400 text-black" : "bg-black text-white";
  const idleClass = tone === "dark" ? "text-gray-300 hover:text-white" : "text-gray-600 hover:text-black";
  return (
    <div
      role="group"
      aria-label={t("language.label")}
      data-testid="language-switcher"
      className={`inline-flex items-center gap-1 text-xs ${className}`}
    >
      {LANGUAGES.map((l) => (
        <button
          key={l.code}
          type="button"
          lang={l.code}
          aria-pressed={active === l.code}
          aria-label={t("language.switchTo", { language: l.label })}
          data-testid={`language-${l.code}`}
          onClick={() => void setLanguage(l.code)}
          className={`px-2 py-0.5 rounded border border-transparent font-semibold ${active === l.code ? activeClass : idleClass}`}
        >
          {l.short}
        </button>
      ))}
    </div>
  );
};
