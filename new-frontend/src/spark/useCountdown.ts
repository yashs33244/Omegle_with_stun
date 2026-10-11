import { useEffect, useState } from "react";

/** Milliseconds left until `until` (local clock), re-rendered every `tickMs` while positive. */
export function useCountdown(until: number, tickMs = 100): number {
  const [remaining, setRemaining] = useState(() => Math.max(0, until - Date.now()));
  useEffect(() => {
    const update = () => setRemaining(Math.max(0, until - Date.now()));
    update();
    if (until <= Date.now()) return;
    const timer = setInterval(() => {
      update();
      if (until <= Date.now()) clearInterval(timer);
    }, tickMs);
    return () => clearInterval(timer);
  }, [until, tickMs]);
  return remaining;
}
