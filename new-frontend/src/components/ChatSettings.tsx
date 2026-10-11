import React, { useState } from "react";
import { Globe, Languages, Settings, Shield } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GenderFilterPicker } from "@/components/GenderFilterPicker";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { Select, SelectItem } from "./retroui/Select";
import { LANGUAGE_OPTIONS } from "../lib/utils";
import { useGenderFilterGate } from "@/premium";
import type { ErrorCode, GenderFilter, Preferences, SimpleAck } from "../lib/protocol";

interface ChatSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  preferences: Preferences;
  /** Sends session:preferences; resolves with the server ack. */
  onUpdatePreferences: (preferences: Preferences) => Promise<SimpleAck>;
}

type Feedback = { tone: "ok" | "error"; text: string } | null;

type SettingsErrorKey = `settings.errors.${"rateLimited" | "invalidPayload" | "banned"}` | "premium:premiumRequired";

const ERROR_KEYS: Partial<Record<ErrorCode, SettingsErrorKey>> = {
  rate_limited: "settings.errors.rateLimited",
  invalid_payload: "settings.errors.invalidPayload",
  banned: "settings.errors.banned",
  premium_required: "premium:premiumRequired",
};

/** In-call settings sheet: match preferences (saved on the server at once) and the app language. */
export const ChatSettings: React.FC<ChatSettingsProps> = ({ isOpen, onClose, preferences, onUpdatePreferences }) => {
  const { t } = useTranslation(["room", "premium"]);
  const gate = useGenderFilterGate();
  const [prefsSaving, setPrefsSaving] = useState(false);
  const [prefsFeedback, setPrefsFeedback] = useState<Feedback>(null);

  const savePreferences = async (next: Preferences) => {
    setPrefsSaving(true);
    setPrefsFeedback(null);
    const res = await onUpdatePreferences(next);
    setPrefsSaving(false);
    if (res.ok === true) {
      setPrefsFeedback({ tone: "ok", text: t("settings.saved") });
    } else {
      if (res.error === "premium_required") gate.openUnlockSheet();
      const key = ERROR_KEYS[res.error];
      setPrefsFeedback({ tone: "error", text: key ? t(key) : (res.message ?? t("settings.errors.generic")) });
    }
  };

  const handleGenderChange = (genderFilter: GenderFilter) => {
    void savePreferences({ ...preferences, genderFilter });
  };

  const handleLanguageChange = (value: string) => {
    if (value !== preferences.languageFilter) {
      void savePreferences({ ...preferences, languageFilter: value });
    }
  };

  return (
    <BottomSheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        <span className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-yellow-400" aria-hidden="true" />
          {t("settings.title")}
        </span>
      }
      closeLabel={t("settings.close")}
      data-testid="chat-settings"
    >
      <div className="space-y-5">
        <GenderFilterPicker
          id="settings-gender"
          value={preferences.genderFilter}
          onChange={handleGenderChange}
          disabled={prefsSaving}
        />

        <div>
          <div className="flex items-center gap-2 mb-2">
            <Globe className="w-4 h-4 text-green-400" aria-hidden="true" />
            <label id="settings-language-label" htmlFor="settings-language" className="text-sm font-medium">
              {t("settings.languageLabel")}
            </label>
          </div>
          <Select
            id="settings-language"
            labelId="settings-language-label"
            aria-label={t("settings.languageLabel")}
            value={preferences.languageFilter}
            onValueChange={handleLanguageChange}
            disabled={prefsSaving}
          >
            <SelectItem value="any">{t("settings.anyLanguage")}</SelectItem>
            {LANGUAGE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {`${opt.flag} ${t(`settings.languages.${opt.value}`)}`}
              </SelectItem>
            ))}
          </Select>
          {prefsSaving && <p className="text-xs mt-2 text-gray-400">{t("settings.saving")}</p>}
          {prefsFeedback && (
            <p role="status" className={`text-xs mt-2 ${prefsFeedback.tone === "ok" ? "text-green-400" : "text-red-400"}`}>
              {prefsFeedback.text}
            </p>
          )}
        </div>

        {/* Reporting lives on the one-tap flag on the partner's video */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Shield className="w-4 h-4 text-red-400" aria-hidden="true" />
            <span className="text-sm font-medium">{t("settings.safety")}</span>
          </div>
          <p className="text-xs text-gray-300">{t("settings.safetyHint")}</p>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-2">
            <Languages className="w-4 h-4 text-yellow-400" aria-hidden="true" />
            <span className="text-sm font-medium">{t("settings.uiLanguage")}</span>
          </div>
          <LanguageSwitcher fullWidth />
        </div>

        <p className="text-xs text-gray-400 text-center border-t border-gray-800 pt-3">{t("settings.footer")}</p>
      </div>
    </BottomSheet>
  );
};
