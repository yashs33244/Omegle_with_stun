import {
  Clock,
  Globe2,
  Lock,
  RefreshCw,
  ShieldAlert,
  WifiOff,
} from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Footer } from "@/components/Footer";
import { Countdown } from "./Countdown";

/**
 * Centred white card on the dark app background, with the footer below. The
 * card and the header share the first screen; the footer follows underneath.
 */
export const GateShell: React.FC<{
  children: React.ReactNode;
  testId?: string;
}> = ({ children, testId }) => {
  const { t } = useTranslation();
  return (
    <div className="bg-gray-900 flex flex-col">
      <div className="min-h-app flex flex-col">
        <header className="px-4 pt-[max(var(--safe-top),1rem)] pb-2 text-center">
          <p className="text-3xl font-bold text-yellow-400">{t("appName")}</p>
        </header>
        <main className="flex-1 flex items-center justify-center px-4 pb-4">
          <div
            data-testid={testId}
            className="w-full max-w-md rounded-xl border-2 border-black bg-white p-6 shadow-md text-black"
          >
            {children}
          </div>
        </main>
      </div>
      <Footer />
    </div>
  );
};

const Title: React.FC<{ icon: React.ReactNode; children: React.ReactNode }> = ({
  icon,
  children,
}) => (
  <div className="text-center space-y-2 mb-4">
    <div className="flex justify-center">{icon}</div>
    <h1 className="text-2xl font-bold">{children}</h1>
  </div>
);

export const Helplines: React.FC = () => {
  const { t } = useTranslation("gate");
  return (
    <div className="text-left text-sm space-y-2" data-testid="helplines">
      <p className="font-bold">{t("helplines.title")}</p>
      <ul className="list-disc pl-5 space-y-1">
        <li>
          <Trans t={t} i18nKey="helplines.india" />
        </li>
        <li>
          <Trans t={t} i18nKey="helplines.unitedStates" />
        </li>
        <li>{t("helplines.anywhere")}</li>
      </ul>
      <p>
        <Trans
          t={t}
          i18nKey="helplines.more"
          components={{ safety: <Link to="/safety" className="underline" /> }}
        />
      </p>
    </div>
  );
};

export const UnderageScreen: React.FC = () => {
  const { t } = useTranslation("gate");
  return (
    <GateShell testId="gate-underage">
      <Title
        icon={<Lock className="w-10 h-10 text-red-600" aria-hidden="true" />}
      >
        {t("underage.title")}
      </Title>
      <div className="space-y-4">
        <p className="text-center text-gray-700">{t("underage.body")}</p>
        <Helplines />
      </div>
    </GateShell>
  );
};

export const RegionBlockedScreen: React.FC<{ country?: string | null }> = ({
  country,
}) => {
  const { t } = useTranslation("gate");
  return (
    <GateShell testId="gate-region-blocked">
      <Title
        icon={<Globe2 className="w-10 h-10 text-gray-700" aria-hidden="true" />}
      >
        {t("region.title")}
      </Title>
      <p className="text-center text-gray-700">
        {country ? t("region.bodyCountry", { country }) : t("region.body")}
      </p>
    </GateShell>
  );
};

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
export const ClosedContent: React.FC<ClosedScreenProps> = ({
  staffedHours,
  reopensAt,
  message,
  onReopen,
  children,
}) => {
  const { t } = useTranslation("gate");
  return (
    <div className="space-y-4 text-center" data-testid="gate-closed">
      <Title
        icon={
          <Clock className="w-10 h-10 text-yellow-600" aria-hidden="true" />
        }
      >
        {staffedHours
          ? t("closed.titleOpen", { staffedHours })
          : t("closed.titleClosed")}
      </Title>
      {message && <p className="text-gray-700">{message}</p>}
      <p className="text-gray-700">{t("closed.body")}</p>
      {reopensAt !== null && reopensAt > 0 && (
        <p className="text-lg">
          <Trans
            t={t}
            i18nKey="closed.opensIn"
            components={{
              countdown: (
                <Countdown
                  until={reopensAt}
                  onDone={onReopen}
                  testId="reopens-countdown"
                />
              ),
            }}
          />
        </p>
      )}
      <p className="text-xs text-gray-500">{t("closed.autoContinue")}</p>
      {children}
    </div>
  );
};

export const ClosedScreen: React.FC<ClosedScreenProps> = (props) => (
  <GateShell>
    <ClosedContent {...props} />
  </GateShell>
);

export const PausedScreen: React.FC<{ onRetry: () => void }> = ({
  onRetry,
}) => {
  const { t } = useTranslation("gate");
  return (
    <GateShell testId="gate-paused">
      <Title
        icon={
          <Clock className="w-10 h-10 text-yellow-600" aria-hidden="true" />
        }
      >
        {t("paused.title")}
      </Title>
      <p className="text-center text-gray-700 mb-4">{t("paused.body")}</p>
      <button type="button" onClick={onRetry} className="retro-button w-full">
        {t("actions.tryAgain")}
      </button>
    </GateShell>
  );
};

export const TurnstileFailedScreen: React.FC<{ onRetry: () => void }> = ({
  onRetry,
}) => {
  const { t } = useTranslation("gate");
  return (
    <GateShell testId="gate-turnstile-failed">
      <Title
        icon={
          <ShieldAlert
            className="w-10 h-10 text-orange-600"
            aria-hidden="true"
          />
        }
      >
        {t("turnstileFailed.title")}
      </Title>
      <p className="text-center text-gray-700 mb-4">
        {t("turnstileFailed.body")}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="retro-button w-full"
        data-testid="gate-retry"
      >
        <RefreshCw className="w-4 h-4 inline mr-2" aria-hidden="true" />
        {t("actions.tryAgain")}
      </button>
    </GateShell>
  );
};

export const LoadErrorScreen: React.FC<{ onRetry: () => void }> = ({
  onRetry,
}) => {
  const { t } = useTranslation("gate");
  return (
    <GateShell testId="gate-load-error">
      <Title
        icon={<WifiOff className="w-10 h-10 text-red-600" aria-hidden="true" />}
      >
        {t("loadError.title")}
      </Title>
      <p className="text-center text-gray-700 mb-4">{t("loadError.body")}</p>
      <button
        type="button"
        onClick={onRetry}
        className="retro-button w-full"
        data-testid="gate-retry"
      >
        {t("actions.tryAgain")}
      </button>
    </GateShell>
  );
};
