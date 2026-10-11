import React from "react";
import { Globe, Languages, MapPin, Settings, Shield } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GenderFilterPicker } from "@/components/GenderFilterPicker";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { HideIpToggle } from "@/components/room/HideIpToggle";
import { Button } from "@/components/retroui/Button";
import { Select, SelectItem } from "@/components/retroui/Select";
import { keepOpenWhenSelectClosed, keepOpenWhileDropdownOpen } from "@/components/retroui/selectDismissal";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { countries, languages } from "@/lib/data";
import type { Preferences } from "@/lib/protocol";
import { LANGUAGE_OPTIONS } from "@/lib/utils";
import type { ProfileForm } from "@/lib/profileForm";

export interface StartSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Profile fields kept here: spoken language and country. */
  form: Pick<ProfileForm, "language" | "country">;
  onFormChange: (patch: Partial<Pick<ProfileForm, "language" | "country">>) => void;
  preferences: Preferences;
  onPreferencesChange: (preferences: Preferences) => void;
  /** Hide my IP is offered at all (GET /api/config privateModeEnabled). */
  privateModeEnabled: boolean;
  hideIp: boolean;
  onHideIpChange: (hideIp: boolean) => void;
}

const Section: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({ icon, title, children }) => (
  <section className="space-y-3">
    <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-gray-400">
      {icon}
      {title}
    </h3>
    {children}
  </section>
);

/**
 * Everything on the start screen that is not Start: who you meet, about you,
 * privacy and the app language. A bottom sheet on phones, a dialog on desktop.
 */
export const StartSettings: React.FC<StartSettingsProps> = ({
  open,
  onOpenChange,
  form,
  onFormChange,
  preferences,
  onPreferencesChange,
  privateModeEnabled,
  hideIp,
  onHideIpChange,
}) => {
  const { t } = useTranslation(["landing", "room"]);
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-yellow-400" aria-hidden="true" />
          {t("landing:settings.title")}
        </span>
      }
      data-testid="start-settings"
      onEscapeKeyDown={keepOpenWhileDropdownOpen}
      onPointerDownOutside={keepOpenWhenSelectClosed}
      footer={
        <Button
          onClick={() => onOpenChange(false)}
          data-testid="settings-done"
          className="w-full min-h-tap justify-center bg-yellow-400 text-black hover:bg-yellow-300"
        >
          {t("landing:settings.done")}
        </Button>
      }
    >
      <div className="space-y-6">
        <Section icon={<Globe className="w-4 h-4" aria-hidden="true" />} title={t("landing:settings.matchHeading")}>
          <GenderFilterPicker
            id="home-gender"
            value={preferences.genderFilter}
            onChange={(genderFilter) => onPreferencesChange({ ...preferences, genderFilter })}
          />
          <div>
            <label id="home-language-filter-label" htmlFor="home-language-filter" className="text-sm font-medium block mb-2">
              {t("room:settings.languageLabel")}
            </label>
            <Select
              id="home-language-filter"
              labelId="home-language-filter-label"
              aria-label={t("room:settings.languageLabel")}
              value={preferences.languageFilter}
              onValueChange={(languageFilter) => onPreferencesChange({ ...preferences, languageFilter })}
            >
              <SelectItem value="any">{t("room:settings.anyLanguage")}</SelectItem>
              {LANGUAGE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {`${opt.flag} ${t(`room:settings.languages.${opt.value}`)}`}
                </SelectItem>
              ))}
            </Select>
          </div>
        </Section>

        <Section icon={<MapPin className="w-4 h-4" aria-hidden="true" />} title={t("landing:settings.profileHeading")}>
          <div>
            <label id="home-language-label" htmlFor="home-language" className="text-sm font-medium block mb-2">
              {t("landing:settings.language")}
            </label>
            <Select
              id="home-language"
              labelId="home-language-label"
              aria-label={t("landing:settings.language")}
              value={form.language}
              onValueChange={(language) => onFormChange({ language })}
            >
              {languages.map((lang) => (
                <SelectItem key={lang.code} value={lang.code}>
                  {t(`landing:languages.${lang.code}`)}
                </SelectItem>
              ))}
            </Select>
          </div>
          <div>
            <label id="home-country-label" htmlFor="home-country" className="text-sm font-medium block mb-2">
              {t("landing:settings.country")}
            </label>
            <Select
              id="home-country"
              labelId="home-country-label"
              aria-label={t("landing:settings.country")}
              value={form.country}
              onValueChange={(country) => onFormChange({ country })}
            >
              {countries.map((country) => (
                <SelectItem key={country.code} value={country.code}>
                  {`${country.flag} ${t(`landing:countries.${country.code}`)}`}
                </SelectItem>
              ))}
            </Select>
          </div>
        </Section>

        {privateModeEnabled && (
          <Section icon={<Shield className="w-4 h-4" aria-hidden="true" />} title={t("landing:settings.privacyHeading")}>
            <HideIpToggle checked={hideIp} onChange={onHideIpChange} />
          </Section>
        )}

        <Section icon={<Languages className="w-4 h-4" aria-hidden="true" />} title={t("room:settings.uiLanguage")}>
          <LanguageSwitcher fullWidth />
        </Section>
      </div>
    </BottomSheet>
  );
};
