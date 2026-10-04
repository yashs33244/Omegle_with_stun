import React, { useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { SafetyHelplines } from "./SafetyInfo";
import { hasSeenSafetyCoach, markSafetyCoachSeen } from "./safetyText";

interface SafetyCoachCardProps {
  onContinue: () => void;
  onBack: () => void;
}

/** First-use safety card, shown once per device before the first match. */
export const SafetyCoachCard: React.FC<SafetyCoachCardProps> = ({ onContinue, onBack }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(true, ref);

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="safety-coach-title"
        data-testid="safety-coach"
        className="w-full max-w-lg rounded-lg border-2 border-yellow-400 bg-gray-800 p-6 text-white shadow-xl"
      >
        <div className="mb-4 flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-yellow-400" aria-hidden="true" />
          <h2 id="safety-coach-title" className="text-xl font-bold">
            Before you start
          </h2>
        </div>
        <ul className="mb-4 list-disc space-y-2 pl-5 text-sm">
          <li>Anyone can record their screen.</li>
          <li>Never undress or move to another app for a stranger.</li>
          <li>If someone threatens you, do not pay; report it.</li>
          <li>Use the flag on their video to report someone. You can leave any call with Skip.</li>
        </ul>
        <h3 className="mb-2 text-sm font-semibold text-yellow-300">If you need help</h3>
        <SafetyHelplines className="mb-4 text-gray-200" />
        <p className="mb-5 text-sm">
          <a href="/safety" className="underline underline-offset-2 hover:text-yellow-300">
            More safety tips
          </a>
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex-1 rounded-lg border border-gray-600 bg-gray-700 px-4 py-2 font-medium hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-yellow-400"
          >
            Back
          </button>
          <button
            type="button"
            onClick={onContinue}
            data-testid="safety-coach-continue"
            className="retro-button flex-1"
          >
            I understand
          </button>
        </div>
      </div>
    </div>
  );
};

/** Renders the safety card until it is dismissed once on this device, then the children. */
export const SafetyCoachGate: React.FC<{ children: React.ReactNode; onBack: () => void }> = ({ children, onBack }) => {
  const [seen, setSeen] = useState(hasSeenSafetyCoach);
  if (seen) return <>{children}</>;
  return (
    <SafetyCoachCard
      onBack={onBack}
      onContinue={() => {
        markSafetyCoachSeen();
        setSeen(true);
      }}
    />
  );
};
