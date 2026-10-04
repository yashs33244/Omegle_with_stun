import React from "react";
import { Flag } from "lucide-react";

interface ReportButtonProps {
  onClick: () => void;
  testId?: string;
  className?: string;
}

/** The one-tap flag shown over the partner's video and on the match card. */
export const ReportButton: React.FC<ReportButtonProps> = ({ onClick, testId = "report-button", className = "" }) => (
  <button
    type="button"
    onClick={onClick}
    data-testid={testId}
    aria-label="Report this person"
    title="Report this person"
    className={`flex items-center gap-1.5 rounded-full border border-white/70 bg-black/60 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-yellow-400 ${className}`}
  >
    <Flag className="h-4 w-4" aria-hidden="true" />
    <span className="hidden sm:inline">Report</span>
  </button>
);
