import { useCallback, useState } from "react";
import { MATCH_MODES, type MatchMode } from "@/lib/protocol";

const MODE_KEY = "chizzy.matchMode";
const HIDE_IP_KEY = "chizzy.hideIp";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
}

/** Instant / Preview and Hide my IP, remembered on this device once the user picks. */
export function useStartOptions(defaultMode: MatchMode) {
  const [storedMode, setStoredMode] = useState<MatchMode | null>(() => {
    const value = read(MODE_KEY);
    return MATCH_MODES.includes(value as MatchMode) ? (value as MatchMode) : null;
  });
  const [hideIp, setHideIpState] = useState<boolean>(() => read(HIDE_IP_KEY) === "1");

  const setMode = useCallback((mode: MatchMode) => {
    write(MODE_KEY, mode);
    setStoredMode(mode);
  }, []);

  const setHideIp = useCallback((value: boolean) => {
    write(HIDE_IP_KEY, value ? "1" : "0");
    setHideIpState(value);
  }, []);

  return { mode: storedMode ?? defaultMode, setMode, hideIp, setHideIp };
}
