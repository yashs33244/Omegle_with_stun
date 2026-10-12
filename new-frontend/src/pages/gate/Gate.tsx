import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Banner } from "@/components/Banner";
import { ServerBusy } from "@/components/ServerBusy";
import { api as defaultApi, type Api, type SessionReply } from "@/lib/api";
import { Backoff } from "@/lib/backoff";
import { getDeviceId } from "@/lib/device";
import { initObservability, trackOnce } from "@/lib/observability";
import type { PublicConfig, Restriction, SessionRequest } from "@/lib/protocol";
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
import { GateForm, type GateNotice, type GateSubmit } from "./GateForm";
import {
  ClosedScreen,
  GateShell,
  LoadErrorScreen,
  PausedScreen,
  RegionBlockedScreen,
  TurnstileFailedScreen,
  UnderageScreen,
} from "./GateScreens";

type FormState = { returning: boolean; notice: GateNotice | null };

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
/** Automatic re-sends of POST /api/session after a transient refusal before the user is asked to retry. */
const SESSION_AUTO_RETRIES = 5;

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
export const Gate: React.FC<GateProps> = ({
  children,
  api = defaultApi,
  fingerprint = defaultFingerprint,
}) => {
  const { t } = useTranslation("gate");
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [banner, setBanner] = useState<string | null>(null);
  const [reverify, setReverify] = useState<FormState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);
  /** Local time of the next automatic POST /api/session while the server is busy. */
  const [busyRetryAt, setBusyRetryAt] = useState<number | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const retries = useRef(new Backoff());
  const retryTimer = useRef<number | undefined>(undefined);
  /** A session request (with its automatic retries) is running. */
  const sending = useRef(false);

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

  useEffect(() => () => window.clearTimeout(retryTimer.current), []);

  // The socket rejected the session or it expired: get a new one over the current page.
  useEffect(
    () =>
      onSessionInvalidated((reason) => {
        if (viewRef.current.kind !== "passed" || !config || sending.current) return;
        const ageToken = getAgeToken(config.tosVersion);
        // An expired session needs no new answer from a returning device when
        // the server asks for no Turnstile: mint the new token silently.
        if (reason === "session_expired" && ageToken && !config.turnstileSiteKey) {
          sending.current = true;
          void sendRef.current({ ageToken, tosVersion: config.tosVersion }, undefined, config.tosVersion, true);
          return;
        }
        setFormError(null);
        setReverify({ returning: ageToken !== null, notice: null });
      }),
    [config],
  );

  // Closed: check again every 30 s (the countdown also triggers a check at the reopening time).
  const recheckClosed = useCallback(async () => {
    const next = await loadConfig();
    if (next && next.matchingOpen && viewRef.current.kind === "closed")
      setView(entryView(next));
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

  const handleResponse = (res: SessionReply, tosVersion: string) => {
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
        return showForm({ returning: false, notice: "dobAgain" });
      case "tos_outdated":
        clearAgeToken();
        return showForm({ returning: false, notice: "tosChanged" });
      case "closed":
        return leave({ kind: "paused" });
      case "banned":
        return leave({
          kind: "restricted",
          restriction: res.restriction ?? unknownRestriction(),
        });
      case "rate_limited":
        setFormError(t("errors.rateLimited"));
        setTurnstileReset((n) => n + 1);
        return;
      case "invalid":
      default:
        setFormError(t("errors.invalid"));
        setTurnstileReset((n) => n + 1);
    }
  };

  /**
   * POSTs the session request. A transient refusal (Retry-After on `closed`
   * or `rate_limited`) is sent again after a jittered backoff while the page
   * shows "busy, retrying"; a silent renewal also retries a network failure.
   * Out of automatic tries, the user gets the form (an overlay if passed).
   */
  const send = async (
    age: SessionRequest["age"],
    turnstileToken: string | undefined,
    tosVersion: string,
    silent: boolean,
  ): Promise<void> => {
    let res: SessionReply | null;
    try {
      res = await api.createSession({
        deviceId: getDeviceId(),
        fingerprint: await fingerprint(),
        ...(turnstileToken ? { turnstileToken } : {}),
        age,
      });
    } catch {
      res = null;
    }
    const retryAfterMs = res && !res.ok ? (res.retryAfterMs ?? null) : null;
    const transient = res === null ? silent : retryAfterMs !== null;
    if (transient && retries.current.failures < SESSION_AUTO_RETRIES) {
      const at = retries.current.nextAttemptAt(retryAfterMs);
      setBusyRetryAt(at);
      retryTimer.current = window.setTimeout(() => void send(age, turnstileToken, tosVersion, silent), at - Date.now());
      return;
    }
    retries.current.reset();
    sending.current = false;
    setBusyRetryAt(null);
    setSubmitting(false);
    if (res !== null && !transient) {
      // A silent renewal that needs the user: open the overlay; handleResponse may replace it with a screen.
      if (silent && !res.ok) setReverify({ returning: true, notice: null });
      return handleResponse(res, tosVersion);
    }
    const rateLimited = res !== null && !res.ok && res.error === "rate_limited";
    setFormError(t(res === null ? "errors.unreachable" : rateLimited ? "errors.rateLimited" : "errors.busy"));
    setTurnstileReset((n) => n + 1);
    if (silent) setReverify({ returning: true, notice: null });
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  const submit = async (input: GateSubmit) => {
    if (!config || submitting || sending.current) return;
    const { tosVersion } = config;
    const ageToken = getAgeToken(tosVersion);
    let age: SessionRequest["age"];
    if (input.dob) age = { dob: input.dob, attest18: true, tosVersion };
    else if (ageToken) age = { ageToken, tosVersion };
    else return showForm({ returning: false, notice: "dobAgain" });

    sending.current = true;
    setSubmitting(true);
    setFormError(null);
    await send(age, input.turnstileToken, tosVersion, false);
  };

  const showRestriction = useCallback(
    (restriction: Restriction) => leave({ kind: "restricted", restriction }),
    [leave],
  );

  // Every function in here is stable; only `config` changes the value.
  const contextValue = useMemo<GateContextValue | null>(
    () =>
      config && {
        config,
        setBanner,
        showRestriction,
        refreshConfig: loadConfig,
      },
    [config, showRestriction, loadConfig],
  );

  const busy = busyRetryAt !== null && (
    <ServerBusy retryAt={busyRetryAt} className="mb-4 rounded border-2 border-black bg-yellow-100 p-3 text-center text-black" />
  );

  const form = (state: FormState) => (
    <>
      {busy}
      <GateForm
        key={`${state.returning}-${state.notice ?? ""}`}
        siteKey={config?.turnstileSiteKey ?? null}
        returning={state.returning}
        notice={state.notice}
        submitting={submitting}
        error={formError}
        turnstileReset={turnstileReset}
        onSubmit={(input) => void submit(input)}
        onTurnstileError={() => setFormError(t("errors.turnstile"))}
      />
    </>
  );

  let content: React.ReactNode;
  switch (view.kind) {
    case "loading":
      content = (
        <div
          className="min-h-screen bg-gray-900 flex items-center justify-center text-white"
          role="status"
        >
          <Loader className="w-10 h-10 animate-spin" aria-hidden="true" />
          <span className="sr-only">{t("loading")}</span>
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
        <RestrictedScreen
          restriction={view.restriction}
          api={api}
          onContinue={() => config && setView(entryView(config))}
        />
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
              aria-label={t("reverify.aria")}
              data-testid="gate-reverify"
              className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-4"
            >
              <div className="w-full max-w-md rounded-lg border-2 border-black bg-white p-6 shadow-md">
                {form(reverify)}
              </div>
            </div>
          )}
          {!reverify && busyRetryAt !== null && (
            <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex justify-center px-4">
              <ServerBusy
                retryAt={busyRetryAt}
                className="rounded-lg border-2 border-black bg-yellow-100 px-4 py-3 text-center text-black shadow-md"
              />
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
