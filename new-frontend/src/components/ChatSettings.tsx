import React, { useEffect, useRef, useState } from 'react';
import { Settings, Shield, Globe, Users, Flag, X } from 'lucide-react';
import { Button } from './retroui/Button';
import { Card, CardContent } from './retroui/Card';
import { Select, SelectItem } from './retroui/Select';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { GENDER_OPTIONS, LANGUAGE_OPTIONS, REPORT_REASON_LABELS } from '../lib/utils';
import {
  GENDER_FILTERS,
  LIMITS,
  REPORT_REASONS,
  type ErrorCode,
  type GenderFilter,
  type Preferences,
  type ReportReason,
  type SimpleAck,
} from '../lib/protocol';

interface ChatSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  preferences: Preferences;
  /** Sends session:preferences; resolves with the server ack. */
  onUpdatePreferences: (preferences: Preferences) => Promise<SimpleAck>;
  /** Sends report:submit for the current call; resolves with the server ack. */
  onReport: (reason: ReportReason, details?: string) => Promise<SimpleAck>;
  canReport: boolean;
}

type Feedback = { tone: 'ok' | 'error'; text: string } | null;

const ERROR_TEXT: Partial<Record<ErrorCode, string>> = {
  rate_limited: 'Too many changes, please wait a moment.',
  not_in_room: 'You are no longer in a call with this user.',
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
  onReport,
  canReport,
}) => {
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [selectedReportReason, setSelectedReportReason] = useState<ReportReason | ''>('');
  const [reportDescription, setReportDescription] = useState('');
  const [prefsSaving, setPrefsSaving] = useState(false);
  const [prefsFeedback, setPrefsFeedback] = useState<Feedback>(null);
  const [reportSending, setReportSending] = useState(false);
  const [reportFeedback, setReportFeedback] = useState<Feedback>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  useDialogFocus(isOpen, settingsRef);
  useDialogFocus(isOpen && showReportDialog, reportRef);

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

  const openReport = () => {
    setReportFeedback(null);
    setShowReportDialog(true);
  };

  const handleReport = async () => {
    if (!selectedReportReason || reportSending) return;
    setReportSending(true);
    const res = await onReport(selectedReportReason, reportDescription.trim() || undefined);
    setReportSending(false);
    if (res.ok === true) {
      setShowReportDialog(false);
      setSelectedReportReason('');
      setReportDescription('');
      setReportFeedback({
        tone: 'ok',
        text: 'User reported. Thank you for helping keep our community safe.',
      });
    } else {
      setReportFeedback({ tone: 'error', text: describeAckError(res) });
    }
  };

  // Escape closes the report dialog first, then the settings panel.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (showReportDialog) setShowReportDialog(false);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, showReportDialog, onClose]);

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

              {/* Report User */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Shield className="w-4 h-4 text-red-400" />
                  <span className="text-sm font-medium text-white">Safety & Moderation</span>
                </div>
                <Button
                  onClick={openReport}
                  disabled={!canReport}
                  variant="outline"
                  className="w-full justify-center bg-red-600 border-red-500 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Flag className="w-4 h-4 mr-2" />
                  Report Current User
                </Button>
                {!canReport && !reportFeedback && (
                  <p className="text-xs mt-2 text-gray-400">You can report someone during a call.</p>
                )}
                {reportFeedback && !showReportDialog && (
                  <p role="status" className={feedbackClass(reportFeedback)}>
                    {reportFeedback.text}
                  </p>
                )}
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

      {/* Report Dialog */}
      {showReportDialog && (
        <div
          ref={reportRef}
          className="fixed inset-0 bg-black bg-opacity-50 z-[60] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="report-title"
        >
          <Card className="w-full max-w-sm bg-gray-800 border-gray-700">
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 id="report-title" className="text-lg font-semibold text-white">
                  Report User
                </h3>
                <Button
                  onClick={() => setShowReportDialog(false)}
                  variant="outline"
                  size="sm"
                  aria-label="Close report"
                  className="bg-gray-700 border-gray-600 text-white hover:bg-gray-600"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>

              <div className="space-y-4">
                <div>
                  <label id="report-reason-label" htmlFor="report-reason" className="text-sm font-medium text-white mb-2 block">
                    Reason for reporting:
                  </label>
                  <Select
                    id="report-reason"
                    labelId="report-reason-label"
                    aria-label="Reason for reporting"
                    value={selectedReportReason}
                    onValueChange={(v) => setSelectedReportReason(v as ReportReason)}
                    placeholder="Select a reason..."
                    className="bg-gray-700 border-gray-600 text-white"
                  >
                    {REPORT_REASONS.map((reason) => (
                      <SelectItem key={reason} value={reason}>
                        {REPORT_REASON_LABELS[reason]}
                      </SelectItem>
                    ))}
                  </Select>
                </div>

                <div>
                  <label htmlFor="report-details" className="text-sm font-medium text-white mb-2 block">
                    Additional details (optional):
                  </label>
                  <textarea
                    id="report-details"
                    value={reportDescription}
                    onChange={(e) => setReportDescription(e.target.value)}
                    placeholder="Describe what happened..."
                    className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:border-yellow-500 focus:outline-none resize-none"
                    rows={3}
                    maxLength={LIMITS.reportDetailsMax}
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    {reportDescription.length}/{LIMITS.reportDetailsMax} characters
                  </p>
                </div>

                {reportFeedback?.tone === 'error' && (
                  <p role="alert" className={feedbackClass(reportFeedback)}>
                    {reportFeedback.text}
                  </p>
                )}

                <div className="flex gap-3">
                  <Button
                    onClick={() => setShowReportDialog(false)}
                    variant="outline"
                    className="flex-1 justify-center bg-gray-700 border-gray-600 text-white hover:bg-gray-600"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => void handleReport()}
                    disabled={!selectedReportReason || reportSending || !canReport}
                    className="flex-1 justify-center bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
                  >
                    {reportSending ? 'Sending...' : 'Submit Report'}
                  </Button>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-gray-700">
                <p className="text-xs text-gray-400 text-center">
                  Reports are reviewed by our moderation team. False reports may result in restrictions.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
};
