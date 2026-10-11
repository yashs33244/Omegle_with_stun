import { useEffect, useRef } from "react";

/**
 * Cloudflare Turnstile, explicit rendering. The script is only requested when
 * the server publishes a site key, and only once per page.
 */
export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
  theme?: "light" | "dark" | "auto";
  action?: string;
}

export interface TurnstileApi {
  render: (el: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile missing")));
    script.onerror = () => reject(new Error("Turnstile failed to load"));
    document.head.appendChild(script);
  }).catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

export interface TurnstileProps {
  siteKey: string;
  /** Called with a fresh token, or null when the token expired or the challenge failed. */
  onToken: (token: string | null) => void;
  /** The widget could not load or the challenge errored. */
  onError: () => void;
  action?: string;
  /** Change it to get a new token (a token is single use). */
  resetKey?: number;
}

export const Turnstile: React.FC<TurnstileProps> = ({ siteKey, onToken, onError, action, resetKey = 0 }) => {
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onToken, onError });
  callbacks.current = { onToken, onError };

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    callbacks.current.onToken(null);
    loadTurnstile()
      .then((ts) => {
        if (cancelled || !container.current) return;
        widgetId = ts.render(container.current, {
          sitekey: siteKey,
          action,
          theme: "light",
          callback: (token) => callbacks.current.onToken(token),
          "error-callback": () => {
            callbacks.current.onToken(null);
            callbacks.current.onError();
          },
          "expired-callback": () => callbacks.current.onToken(null),
          "timeout-callback": () => callbacks.current.onToken(null),
        });
      })
      .catch(() => {
        if (!cancelled) callbacks.current.onError();
      });
    return () => {
      cancelled = true;
      if (widgetId !== null) window.turnstile?.remove(widgetId);
    };
  }, [siteKey, action, resetKey]);

  return <div ref={container} data-testid="turnstile" className="min-h-[65px] flex justify-center" />;
};
