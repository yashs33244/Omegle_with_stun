import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader } from "lucide-react";
import { Banner } from "@/components/Banner";
import { api as defaultApi, type Api } from "@/lib/api";
import { getDeviceId } from "@/lib/device";
import { initObservability, trackOnce } from "@/lib/observability";
import type { PublicConfig, Restriction, SessionRequest, SessionResponse } from "@/lib/protocol";
import {
  clearAgeToken,
  fingerprint as defaultFingerprint,
  getAgeToken,
  getSessionToken,
  isLockedOut,
  markLockedOut,
  onSessionInvalidated,
  saveSession,
} from "@/lib/session";
import { RestrictedScreen } from "../Restricted";
import { GateContext, type GateContextValue } from "./GateContext";
import { GateForm, type GateSubmit } from "./GateForm";
import {
  ClosedScreen,
  GateShell,
  LoadErrorScreen,
  PausedScreen,
  RegionBlockedScreen,
  TurnstileFailedScreen,
  UnderageScreen,
} from "./GateScreens";

type FormState = { returning: boolean; notice: string | null };

type View =
  | { kind: "loading" }
  | { kind: "load-error" }
  | { kind: "closed" }
  | { kind: "paused" }
  | ({ kind: "form" } & FormState)
  | { kind: "underage" }
  | { kind: "region" }
  | { kind: "restricted"; restriction: Restriction }
  | { kind: "turnstile-failed" }
  | { kind: "passed" };

const CLOSED_POLL_MS = 30_000;

const NOTICE_DOB_AGAIN = "Please confirm your date of birth again.";
const NOTICE_TOS_CHANGED = "Our Terms have changed. Please review them and accept them again to continue.";

/** Shown when the server refuses a device without sending the restriction itself. */
function unknownRestriction(): Restriction {
  return {
    id: "",
    reason: "other",
    kind: "ban",
    until: null,
    createdAt: Date.now(),
    evidenceAvailable: false,
    appeal: { status: "none" },
    appealable: false,
  };
}

/** Where a visitor starts, given the config and what this device already holds. */
function entryView(config: PublicConfig): View {
  if (isLockedOut()) return { kind: "underage" };
  if (!config.matchingOpen) return { kind: "closed" };
  const ageToken = getAgeToken(config.tosVersion);
  if (ageToken && getSessionToken()) return { kind: "passed" };
  return { kind: "form", returning: ageToken !== null, notice: null };
}

export interface GateProps {
  children: React.ReactNode;
  api?: Api;
  fingerprint?: () => Promise<string>;
}

/**
 * Session gate in front of the camera: date of birth, 18+ attestation, Terms,
 * Turnstile, then POST /api/session. Renders `children` only with a session.
 * If the socket later rejects the session, a Turnstile-only check opens over
 * the page and the socket reconnects once a new token is saved.
 */
export const Gate: React.FC<GateProps> = ({ children, api = defaultApi, fingerprint = defaultFingerprint }) => {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [banner, setBanner] = useState<string | null>(null);
  const [reverify, setReverify] = useState<FormState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  const loadConfig = useCallback(async (): Promise<PublicConfig | null> => {
    try {
      const next = await api.getConfig();
      setConfig(next);
      setBanner(next.banner);
      return next;
    } catch {
      return null;
    }
  }, [api]);

  const start = useCallback(async () => {
    setView({ kind: "loading" });
    const next = await loadConfig();
    if (!next) {
      setView({ kind: "load-error" });
      return;
    }
    void initObservability(next);
    setView(entryView(next));
  }, [loadConfig]);

  useEffect(() => {
    trackOnce("landing_view");
    void start();
  }, [start]);

  useEffect(() => {
    if (view.kind === "passed") trackOnce("gate_passed");
  }, [view.kind]);

  // The socket rejected the session: ask again over the current page.
  useEffect(
    () =>
      onSessionInvalidated(() => {
        if (viewRef.current.kind !== "passed" || !config) return;
        setFormError(null);
        setReverify({ returning: getAgeToken(config.tosVersion) !== null, notice: null });
      }),
    [config],
  );

  // Closed: check again every 30 s (the countdown also triggers a check at the reopening time).
  const recheckClosed = useCallback(async () => {
    const next = await loadConfig();
    if (next && next.matchingOpen && viewRef.current.kind === "closed") setView(entryView(next));
  }, [loadConfig]);

  useEffect(() => {
    if (view.kind !== "closed") return;
    const t = setInterval(() => void recheckClosed(), CLOSED_POLL_MS);
    return () => clearInterval(t);
  }, [view.kind, recheckClosed]);

  const showForm = (state: FormState) => {
    if (viewRef.current.kind === "passed") setReverify(state);
    else setView({ kind: "form", ...state });
  };

  const leave = useCallback((next: View) => {
    setReverify(null);
    setView(next);
  }, []);

  const handleResponse = (res: SessionResponse, tosVersion: string) => {
    if (res.ok) {
      saveSession(res, tosVersion);
      leave({ kind: "passed" });
      return;
    }
    switch (res.error) {
      case "underage":
      case "locked":
        markLockedOut();
        return leave({ kind: "underage" });
      case "region_blocked":
        return leave({ kind: "region" });
      case "turnstile_failed":
        return leave({ kind: "turnstile-failed" });
      case "age_token_invalid":
        clearAgeToken();
        return showForm({ returning: false, notice: NOTICE_DOB_AGAIN });
      case "tos_outdated":
        clearAgeToken();
        return showForm({ returning: false, notice: NOTICE_TOS_CHANGED });
      case "closed":
        return leave({ kind: "paused" });
      case "banned":
        return leave({ kind: "restricted", restriction: res.restriction ?? unknownRestriction() });
      case "rate_limited":
        setFormError("Too many tries. Wait a minute and try again.");
        setTurnstileReset((n) => n + 1);
        return;
      case "invalid":
      default:
        setFormError("We could not accept that. Check your date of birth and try again.");
        setTurnstileReset((n) => n + 1);
    }
  };

  const submit = async (input: GateSubmit) => {
    if (!config || submitting) return;
    const { tosVersion } = config;
    const ageToken = getAgeToken(tosVersion);
    let age: SessionRequest["age"];
    if (input.dob) age = { dob: input.dob, attest18: true, tosVersion };
    else if (ageToken) age = { ageToken, tosVersion };
    else return showForm({ returning: false, notice: NOTICE_DOB_AGAIN });

    setSubmitting(true);
    setFormError(null);
    try {
      const res = await api.createSession({
        deviceId: getDeviceId(),
        fingerprint: await fingerprint(),
        ...(input.turnstileToken ? { turnstileToken: input.turnstileToken } : {}),
        age,
      });
      handleResponse(res, tosVersion);
    } catch {
      setFormError("Cannot reach Chizzy. Check your connection and try again.");
      setTurnstileReset((n) => n + 1);
    } finally {
      setSubmitting(false);
    }
  };

  const contextValue = useMemo<GateContextValue | null>(
    () =>
      config && {
        config,
        setBanner,
        showRestriction: (restriction) => leave({ kind: "restricted", restriction }),
        refreshConfig: loadConfig,
      },
    [config, loadConfig, leave],
  );

  const form = (state: FormState) => (
    <GateForm
      key={`${state.returning}-${state.notice ?? ""}`}
      siteKey={config?.turnstileSiteKey ?? null}
      returning={state.returning}
      notice={state.notice}
      submitting={submitting}
      error={formError}
      turnstileReset={turnstileReset}
      onSubmit={(input) => void submit(input)}
      onTurnstileError={() => setFormError("The security check could not load. Check your connection and try again.")}
    />
  );

  let content: React.ReactNode;
  switch (view.kind) {
    case "loading":
      content = (
        <div className="min-h-screen bg-gray-900 flex items-center justify-center text-white" role="status">
          <Loader className="w-10 h-10 animate-spin" aria-hidden="true" />
          <span className="sr-only">Loading</span>
        </div>
      );
      break;
    case "load-error":
      content = <LoadErrorScreen onRetry={() => void start()} />;
      break;
    case "closed":
      content = (
        <ClosedScreen
          staffedHours={config?.staffedHours ?? null}
          reopensAt={config?.reopensAt ?? null}
          onReopen={() => void recheckClosed()}
        />
      );
      break;
    case "paused":
      content = <PausedScreen onRetry={() => void start()} />;
      break;
    case "form":
      content = <GateShell testId="gate">{form(view)}</GateShell>;
      break;
    case "underage":
      content = <UnderageScreen />;
      break;
    case "region":
      content = <RegionBlockedScreen />;
      break;
    case "restricted":
      content = (
        <RestrictedScreen restriction={view.restriction} api={api} onContinue={() => config && setView(entryView(config))} />
      );
      break;
    case "turnstile-failed":
      content = (
        <TurnstileFailedScreen
          onRetry={() => {
            setFormError(null);
            setTurnstileReset((n) => n + 1);
            if (config) setView(entryView(config));
          }}
        />
      );
      break;
    case "passed":
      content = (
        <>
          {children}
          {reverify && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Confirm to continue"
              data-testid="gate-reverify"
              className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-4"
            >
              <div className="w-full max-w-md rounded-lg border-2 border-black bg-white p-6 shadow-md">{form(reverify)}</div>
            </div>
          )}
        </>
      );
      break;
  }

  return (
    <GateContext.Provider value={contextValue}>
      <Banner message={banner} />
      {content}
    </GateContext.Provider>
  );
};
