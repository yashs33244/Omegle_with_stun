import React, { useEffect, useRef, useState } from 'react';
import { Settings, Shield, Globe, Users, X } from 'lucide-react';
import { Button } from './retroui/Button';
import { Card, CardContent } from './retroui/Card';
import { Select, SelectItem } from './retroui/Select';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { GENDER_OPTIONS, LANGUAGE_OPTIONS } from '../lib/utils';
import {
  GENDER_FILTERS,
  type ErrorCode,
  type GenderFilter,
  type Preferences,
  type SimpleAck,
} from '../lib/protocol';

interface ChatSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  preferences: Preferences;
  /** Sends session:preferences; resolves with the server ack. */
  onUpdatePreferences: (preferences: Preferences) => Promise<SimpleAck>;
}

type Feedback = { tone: 'ok' | 'error'; text: string } | null;

const ERROR_TEXT: Partial<Record<ErrorCode, string>> = {
  rate_limited: 'Too many changes, please wait a moment.',
  invalid_payload: 'That value was not accepted.',
  banned: 'Your session is restricted.',
};

function describeAckError(res: Extract<SimpleAck, { ok: false }>): string {
  return ERROR_TEXT[res.error] ?? res.message ?? 'Something went wrong. Please try again.';
}

const isGenderFilter = (v: string): v is GenderFilter =>
  (GENDER_FILTERS as readonly string[]).includes(v);

export const ChatSettings: React.FC<ChatSettingsProps> = ({
  isOpen,
  onClose,
  preferences,
  onUpdatePreferences,
}) => {
  const [prefsSaving, setPrefsSaving] = useState(false);
  const [prefsFeedback, setPrefsFeedback] = useState<Feedback>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  useDialogFocus(isOpen, settingsRef);

  const savePreferences = async (next: Preferences) => {
    setPrefsSaving(true);
    setPrefsFeedback(null);
    const res = await onUpdatePreferences(next);
    setPrefsSaving(false);
    setPrefsFeedback(
      res.ok === true
        ? { tone: 'ok', text: 'Saved. Applies to your next match.' }
        : { tone: 'error', text: describeAckError(res) }
    );
  };

  const handleGenderChange = (value: string) => {
    if (isGenderFilter(value) && value !== preferences.genderFilter) {
      void savePreferences({ ...preferences, genderFilter: value });
    }
  };

  const handleLanguageChange = (value: string) => {
    if (value !== preferences.languageFilter) {
      void savePreferences({ ...preferences, languageFilter: value });
    }
  };

  // Escape closes the settings panel.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const feedbackClass = (f: NonNullable<Feedback>) =>
    `text-xs mt-2 ${f.tone === 'ok' ? 'text-green-400' : 'text-red-400'}`;

  return (
    <>
      {/* Main Settings Panel */}
      <div
        ref={settingsRef}
        className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-settings-title"
      >
        <Card className="w-full max-w-md bg-gray-800 border-gray-700">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-yellow-400" />
                <h2 id="chat-settings-title" className="text-lg font-semibold text-white">
                  Chat Settings
                </h2>
              </div>
              <Button
                onClick={onClose}
                variant="outline"
                size="sm"
                aria-label="Close settings"
                className="bg-gray-700 border-gray-600 text-white hover:bg-gray-600"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            <div className="space-y-6">
              {/* Gender Filter */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Users className="w-4 h-4 text-blue-400" />
                  <label id="settings-gender-label" htmlFor="settings-gender" className="text-sm font-medium text-white">
                    Who do you want to meet?
                  </label>
                </div>
                <Select
                  id="settings-gender"
                  labelId="settings-gender-label"
                  aria-label="Who do you want to meet?"
                  value={preferences.genderFilter}
                  onValueChange={handleGenderChange}
                  disabled={prefsSaving}
                  className="bg-gray-700 border-gray-600 text-white"
                >
                  {GENDER_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </Select>
              </div>

              {/* Language Selection */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Globe className="w-4 h-4 text-green-400" />
                  <label id="settings-language-label" htmlFor="settings-language" className="text-sm font-medium text-white">
                    Preferred Language
                  </label>
                </div>
                <Select
                  id="settings-language"
                  labelId="settings-language-label"
                  aria-label="Preferred Language"
                  value={preferences.languageFilter}
                  onValueChange={handleLanguageChange}
                  disabled={prefsSaving}
                  className="bg-gray-700 border-gray-600 text-white"
                >
                  <SelectItem value="any">🌐 Any language</SelectItem>
                  {LANGUAGE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {`${opt.flag} ${opt.label}`}
                    </SelectItem>
                  ))}
                </Select>
                {prefsSaving && <p className="text-xs mt-2 text-gray-400">Saving...</p>}
                {prefsFeedback && (
                  <p role="status" className={feedbackClass(prefsFeedback)}>
                    {prefsFeedback.text}
                  </p>
                )}
              </div>

              {/* Reporting moved to the one-tap flag on the partner's video */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Shield className="w-4 h-4 text-red-400" />
                  <span className="text-sm font-medium text-white">Safety</span>
                </div>
                <p className="text-xs text-gray-300">
                  To report someone, tap the flag on their video. After a call ends you can still report it for 60
                  seconds.
                </p>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-gray-700">
              <p className="text-xs text-gray-400 text-center">
                Changes apply from your next match.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

    </>
  );
};
