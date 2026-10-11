import { useEffect, useState } from "react";
import { formatDuration } from "./dob";

/** Re-renders every second until `until` (epoch ms), then calls onDone once. */
function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

export const Countdown: React.FC<{ until: number; onDone?: () => void; testId?: string }> = ({ until, onDone, testId }) => {
  const now = useNow(true);
  const left = until - now;
  useEffect(() => {
    if (left > 0 || !onDone) return;
    onDone();
    // Fire once when the deadline passes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left <= 0]);
  return (
    <span data-testid={testId} className="tabular-nums">
      {formatDuration(left)}
    </span>
  );
};
