import React, { useState } from 'react';
import { 
  Settings, 
  Shield, 
  Globe, 
  Users, 
  Flag,
  X 
} from 'lucide-react';
import { Button } from './retroui/Button';
import { Card, CardContent } from './retroui/Card';
import { Select } from './retroui/Select';
import { Dialog } from './retroui/Dialog';
import { 
  GENDER_OPTIONS, 
  LANGUAGE_OPTIONS, 
  REPORT_REASONS 
} from '../lib/utils';

interface ChatSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onGenderFilterChange: (gender: string) => void;
  onLanguageChange: (language: string) => void;
  onReport: (reason: string, description?: string) => void;
  currentGenderFilter: string;
  currentLanguage: string;
  canReport: boolean;
}

export const ChatSettings: React.FC<ChatSettingsProps> = ({
  isOpen,
  onClose,
  onGenderFilterChange,
  onLanguageChange,
  onReport,
  currentGenderFilter,
  currentLanguage,
  canReport
}) => {
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [selectedReportReason, setSelectedReportReason] = useState('');
  const [reportDescription, setReportDescription] = useState('');

  const handleReport = () => {
    if (selectedReportReason) {
      onReport(selectedReportReason, reportDescription);
      setShowReportDialog(false);
      setSelectedReportReason('');
      setReportDescription('');
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Main Settings Panel */}
      <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
        <Card className="w-full max-w-md bg-gray-800 border-gray-700">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-yellow-400" />
                <h2 className="text-lg font-semibold text-white">Chat Settings</h2>
              </div>
              <Button
                onClick={onClose}
                variant="outline"
                size="sm"
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
                  <label className="text-sm font-medium text-white">
                    Who do you want to meet?
                  </label>
                </div>
                <Select
                  value={currentGenderFilter}
                  onValueChange={onGenderFilterChange}
                  options={GENDER_OPTIONS.map(opt => ({
                    value: opt.value,
                    label: opt.label
                  }))}
                  className="bg-gray-700 border-gray-600 text-white"
                />
              </div>

              {/* Language Selection */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Globe className="w-4 h-4 text-green-400" />
                  <label className="text-sm font-medium text-white">
                    Preferred Language
                  </label>
                </div>
                <Select
                  value={currentLanguage}
                  onValueChange={onLanguageChange}
                  options={LANGUAGE_OPTIONS.map(opt => ({
                    value: opt.value,
                    label: `${opt.flag} ${opt.label}`
                  }))}
                  className="bg-gray-700 border-gray-600 text-white"
                />
              </div>

              {/* Report User */}
              {canReport && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Shield className="w-4 h-4 text-red-400" />
                    <label className="text-sm font-medium text-white">
                      Safety & Moderation
                    </label>
                  </div>
                  <Button
                    onClick={() => setShowReportDialog(true)}
                    variant="outline"
                    className="w-full bg-red-600 border-red-500 text-white hover:bg-red-500"
                  >
                    <Flag className="w-4 h-4 mr-2" />
                    Report Current User
                  </Button>
                </div>
              )}
            </div>

            <div className="mt-6 pt-4 border-t border-gray-700">
              <p className="text-xs text-gray-400 text-center">
                Settings are applied immediately and saved for your next session
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Report Dialog */}
      {showReportDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-[60] flex items-center justify-center p-4">
          <Card className="w-full max-w-sm bg-gray-800 border-gray-700">
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-white">Report User</h3>
                <Button
                  onClick={() => setShowReportDialog(false)}
                  variant="outline"
                  size="sm"
                  className="bg-gray-700 border-gray-600 text-white hover:bg-gray-600"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-white mb-2 block">
                    Reason for reporting:
                  </label>
                  <Select
                    value={selectedReportReason}
                    onValueChange={setSelectedReportReason}
                    options={REPORT_REASONS.map(reason => ({
                      value: reason,
                      label: reason
                    }))}
                    placeholder="Select a reason..."
                    className="bg-gray-700 border-gray-600 text-white"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium text-white mb-2 block">
                    Additional details (optional):
                  </label>
                  <textarea
                    value={reportDescription}
                    onChange={(e) => setReportDescription(e.target.value)}
                    placeholder="Describe what happened..."
                    className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:border-yellow-500 focus:outline-none resize-none"
                    rows={3}
                    maxLength={500}
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    {reportDescription.length}/500 characters
                  </p>
                </div>

                <div className="flex gap-3">
                  <Button
                    onClick={() => setShowReportDialog(false)}
                    variant="outline"
                    className="flex-1 bg-gray-700 border-gray-600 text-white hover:bg-gray-600"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleReport}
                    disabled={!selectedReportReason}
                    className="flex-1 bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
                  >
                    Submit Report
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