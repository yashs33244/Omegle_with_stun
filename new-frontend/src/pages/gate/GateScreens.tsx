import { Clock, Globe2, Lock, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import { Link } from "react-router-dom";
import { Footer } from "@/components/Footer";
import { Countdown } from "./Countdown";

/** Centered white card on the dark app background, with the footer below. */
export const GateShell: React.FC<{ children: React.ReactNode; testId?: string }> = ({ children, testId }) => (
  <div className="min-h-screen bg-gray-900 flex flex-col">
    <header className="px-6 pt-6 text-center">
      <p className="text-3xl font-bold text-yellow-400">Chizzy</p>
    </header>
    <main className="flex-1 flex items-center justify-center p-4">
      <div
        data-testid={testId}
        className="w-full max-w-md rounded-lg border-2 border-black bg-white p-6 shadow-md text-black"
      >
        {children}
      </div>
    </main>
    <Footer />
  </div>
);

const Title: React.FC<{ icon: React.ReactNode; children: React.ReactNode }> = ({ icon, children }) => (
  <div className="text-center space-y-2 mb-4">
    <div className="flex justify-center">{icon}</div>
    <h1 className="text-2xl font-bold">{children}</h1>
  </div>
);

export const Helplines: React.FC = () => (
  <div className="text-left text-sm space-y-2" data-testid="helplines">
    <p className="font-bold">If you need to talk to someone or you are not safe:</p>
    <ul className="list-disc pl-5 space-y-1">
      <li>
        India: Childline <strong>1098</strong>, Cyber Crime Helpline <strong>1930</strong>
      </li>
      <li>
        United States: call or text <strong>988</strong> (Suicide and Crisis Lifeline). To report online sexual
        exploitation of a child, use the NCMEC CyberTipline at report.cybertip.org or 1-800-843-5678.
      </li>
      <li>Anywhere: call your local emergency number if you are in danger.</li>
    </ul>
    <p>
      More on our <Link to="/safety" className="underline">Safety page</Link>.
    </p>
  </div>
);

export const UnderageScreen: React.FC = () => (
  <GateShell testId="gate-underage">
    <Title icon={<Lock className="w-10 h-10 text-red-600" aria-hidden="true" />}>Chizzy is for adults only</Title>
    <div className="space-y-4">
      <p className="text-center text-gray-700">
        You need to be 18 or older to use Chizzy, so it is locked on this device. This is not something you did wrong.
      </p>
      <Helplines />
    </div>
  </GateShell>
);

export const RegionBlockedScreen: React.FC<{ country?: string | null }> = ({ country }) => (
  <GateShell testId="gate-region-blocked">
    <Title icon={<Globe2 className="w-10 h-10 text-gray-700" aria-hidden="true" />}>
      Chizzy is not available in your country yet
    </Title>
    <p className="text-center text-gray-700">
      We are launching one region at a time{country ? ` and cannot open in ${country} yet` : ""}. Using a VPN to get
      around this breaks our Terms.
    </p>
  </GateShell>
);

export interface ClosedScreenProps {
  /** Human-readable window, e.g. "8 pm to midnight IST". */
  staffedHours: string | null;
  reopensAt: number | null;
  message?: string | null;
  onReopen?: () => void;
  /** Extra actions, e.g. Back to home inside a call screen. */
  children?: React.ReactNode;
}

/** Matching is closed: outside staffed hours or paused by the operator. */
export const ClosedContent: React.FC<ClosedScreenProps> = ({ staffedHours, reopensAt, message, onReopen, children }) => (
  <div className="space-y-4 text-center" data-testid="gate-closed">
    <Title icon={<Clock className="w-10 h-10 text-yellow-600" aria-hidden="true" />}>
      {staffedHours ? `Chizzy is open ${staffedHours}` : "Chizzy is closed right now"}
    </Title>
    {message && <p className="text-gray-700">{message}</p>}
    <p className="text-gray-700">
      We only match people while our safety team is on duty, so someone is around to handle reports.
    </p>
    {reopensAt !== null && reopensAt > 0 && (
      <p className="text-lg">
        Opens in <Countdown until={reopensAt} onDone={onReopen} testId="reopens-countdown" />
      </p>
    )}
    <p className="text-xs text-gray-500">This page continues by itself when we open.</p>
    {children}
  </div>
);

export const ClosedScreen: React.FC<ClosedScreenProps> = (props) => (
  <GateShell>
    <ClosedContent {...props} />
  </GateShell>
);

export const PausedScreen: React.FC<{ onRetry: () => void }> = ({ onRetry }) => (
  <GateShell testId="gate-paused">
    <Title icon={<Clock className="w-10 h-10 text-yellow-600" aria-hidden="true" />}>New sessions are paused</Title>
    <p className="text-center text-gray-700 mb-4">Chizzy is not taking new visitors right now. Please try again later.</p>
    <button type="button" onClick={onRetry} className="retro-button w-full">
      Try again
    </button>
  </GateShell>
);

export const TurnstileFailedScreen: React.FC<{ onRetry: () => void }> = ({ onRetry }) => (
  <GateShell testId="gate-turnstile-failed">
    <Title icon={<ShieldAlert className="w-10 h-10 text-orange-600" aria-hidden="true" />}>
      We could not confirm you are a person
    </Title>
    <p className="text-center text-gray-700 mb-4">
      The security check did not pass. This can happen with a VPN, an ad blocker or a slow connection. Try again, or
      switch networks.
    </p>
    <button type="button" onClick={onRetry} className="retro-button w-full" data-testid="gate-retry">
      <RefreshCw className="w-4 h-4 inline mr-2" aria-hidden="true" />
      Try again
    </button>
  </GateShell>
);

export const LoadErrorScreen: React.FC<{ onRetry: () => void }> = ({ onRetry }) => (
  <GateShell testId="gate-load-error">
    <Title icon={<WifiOff className="w-10 h-10 text-red-600" aria-hidden="true" />}>Cannot reach Chizzy</Title>
    <p className="text-center text-gray-700 mb-4">Check your connection and try again.</p>
    <button type="button" onClick={onRetry} className="retro-button w-full" data-testid="gate-retry">
      Try again
    </button>
  </GateShell>
);
