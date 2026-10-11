import { useTranslation } from "react-i18next";
import { Segmented } from "@/components/ui/Segmented";
import { LANGUAGES, currentLang, setLanguage, type Lang } from "@/lib/i18n";

/** EN / हिन्दी segmented control. Shown in the footer and in the settings sheets. */
export const LanguageSwitcher: React.FC<{ tone?: "dark" | "light"; className?: string; fullWidth?: boolean }> = ({
  tone = "dark",
  className = "",
  fullWidth = false,
}) => {
  const { t } = useTranslation();
  return (
    <Segmented<Lang>
      role="group"
      aria-label={t("language.label")}
      data-testid="language-switcher"
      tone={tone}
      fullWidth={fullWidth}
      className={className}
      value={currentLang()}
      onChange={(code) => void setLanguage(code)}
      options={LANGUAGES.map((l) => ({
        value: l.code,
        label: l.short,
        lang: l.code,
        testId: `language-${l.code}`,
        ariaLabel: t("language.switchTo", { language: l.label }),
      }))}
    />
  );
};
