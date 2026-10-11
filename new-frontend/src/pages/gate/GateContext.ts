import { createContext, useContext } from "react";
import type { PublicConfig, Restriction } from "@/lib/protocol";

export interface GateContextValue {
  config: PublicConfig;
  /** Replace the operator banner (live server:banner events). */
  setBanner: (message: string | null) => void;
  /** A restriction arrived mid-session: leave the room and show it. */
  showRestriction: (restriction: Restriction) => void;
  /** Re-read /api/config, e.g. after a hello was refused. */
  refreshConfig: () => Promise<PublicConfig | null>;
}

export const GateContext = createContext<GateContextValue | null>(null);

/** Null outside the gate (unit tests that render a page on its own). */
export function useGate(): GateContextValue | null {
  return useContext(GateContext);
}
