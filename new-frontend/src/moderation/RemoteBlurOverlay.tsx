import React from "react";
import { EyeOff, Flag, ShieldCheck, SkipForward } from "lucide-react";
import type { BlurStatus } from "./blurGate";

interface RemoteBlurOverlayProps {
  status: BlurStatus;
  /** "Tap to show video" after the safety check could not run. */
  onReveal: () => void;
  onReport: () => void;
  onNext: () => void;
}

/** What sits on top of the partner's (blurred) video while the safety check decides. */
export const RemoteBlurOverlay: React.FC<RemoteBlurOverlayProps> = ({ status, onReveal, onReport, onNext }) => {
  if (status === "checking") {
    return (
      <div className="absolute top-14 inset-x-0 flex justify-center pointer-events-none" style={{ zIndex: 6 }}>
        <div
          role="status"
          data-testid="video-checking"
          className="flex items-center gap-2 bg-black bg-opacity-70 text-white text-xs px-3 py-1 rounded-full"
        >
          <ShieldCheck className="w-4 h-4 text-green-400" aria-hidden="true" />
          Checking the video on your device...
        </div>
      </div>
    );
  }

  if (status === "flagged") {
    return (
      <div className="video-loading-overlay" role="alert" data-testid="video-hidden" style={{ zIndex: 20 }}>
        <div className="text-center text-white space-y-4 px-4">
          <EyeOff className="w-12 h-12 text-red-400 mx-auto" aria-hidden="true" />
          <p className="text-lg font-bold">Video hidden</p>
          <p className="text-sm text-gray-300">Our on-device check thinks this video may show nudity.</p>
          <div className="flex gap-3 justify-center">
            <button type="button" onClick={onReport} className="retro-button bg-red-500 text-white" data-testid="hidden-report">
              <Flag className="w-4 h-4 inline mr-2" aria-hidden="true" />
              Report
            </button>
            <button type="button" onClick={onNext} className="retro-button" data-testid="hidden-next">
              <SkipForward className="w-4 h-4 inline mr-2" aria-hidden="true" />
              Next
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="video-loading-overlay" data-testid="video-unchecked" style={{ zIndex: 20 }}>
        <div className="text-center text-white space-y-4 px-4">
          <EyeOff className="w-12 h-12 text-yellow-400 mx-auto" aria-hidden="true" />
          <p className="text-lg font-bold">Video blurred</p>
          <p className="text-sm text-gray-300">The safety check could not run on this device, so the video stays blurred.</p>
          <div className="flex gap-3 justify-center">
            <button type="button" onClick={onReveal} className="retro-button" data-testid="tap-to-show">
              Tap to show video
            </button>
            <button type="button" onClick={onNext} className="retro-button">
              Next
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
};
