import { useEffect } from "react";

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
}
type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> } };

/**
 * Keeps the screen on while `active` (during a call). The browser drops the
 * lock when the page is hidden, so it is requested again when the page comes back.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const wakeLock = (navigator as WakeLockNavigator).wakeLock;
    if (!active || !wakeLock) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let stopped = false;

    const acquire = async () => {
      if (stopped || document.visibilityState !== "visible" || (sentinel && !sentinel.released)) return;
      try {
        const lock = await wakeLock.request("screen");
        if (stopped) void lock.release().catch(() => {});
        else sentinel = lock;
      } catch {
        // Refused (battery saver, no user gesture yet): the call works without it.
      }
    };
    const onVisible = () => void acquire();

    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => {});
    };
  }, [active]);
}
