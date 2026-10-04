/**
 * Pushes "matching:status" and "server:banner" to this instance's sockets
 * when the flags change, and re-checks the status on a timer so staffed-hours
 * boundaries are announced without a flag change. Every instance does this
 * for its own sockets (io.local), so nothing crosses the adapter.
 */
import type { FlagsReader, MatchingStatus } from "../flags/flags";
import type { ServerToClientEvents } from "../protocol";

interface LocalEmitter {
  local: { emit<E extends keyof ServerToClientEvents>(event: E, ...args: Parameters<ServerToClientEvents[E]>): boolean };
}

function sameStatus(a: MatchingStatus, b: MatchingStatus): boolean {
  return a.open === b.open && a.reopensAt === b.reopensAt && a.message === b.message;
}

/** Starts watching; returns a stop function. */
export function startMatchingBroadcast(
  io: LocalEmitter,
  flags: FlagsReader,
  intervalMs: number,
  now: () => number = Date.now,
): () => void {
  let status = flags.status(now());
  let banner = flags.current().banner_message || null;

  const check = () => {
    const nextStatus = flags.status(now());
    if (!sameStatus(nextStatus, status)) {
      status = nextStatus;
      io.local.emit("matching:status", { ...status });
    }
    const nextBanner = flags.current().banner_message || null;
    if (nextBanner !== banner) {
      banner = nextBanner;
      io.local.emit("server:banner", { message: banner });
    }
  };

  const unsubscribe = flags.onChange(check);
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}
