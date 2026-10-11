/**
 * The gender picker's view of premium (contract with the UX lanes):
 *
 *   const gate = useGenderFilterGate();
 *   if (gate.enabled && !gate.unlocked && value !== "all") gate.openUnlockSheet(); else save(value);
 *
 * `enabled` mirrors the premium_filters_enabled flag: false means the filter
 * is free and no lock is shown. Outside a PremiumProvider (tests) the filter
 * behaves as free.
 */
import { useCallback } from "react";
import { unlockFor, usePremium } from "./PremiumContext";

export interface GenderFilterGate {
  unlocked: boolean;
  /** Epoch ms the unlock ends, or null. */
  expiresAt: number | null;
  /** Coin balance, 0 until known. */
  coins: number;
  /** Coins per day of gender filter. */
  costPerDay: number;
  /** The gender filter costs coins right now. */
  enabled: boolean;
  openUnlockSheet: () => void;
}

export function useGenderFilterGate(): GenderFilterGate {
  const premium = usePremium();
  const expiresAt = unlockFor(premium?.wallet ?? null, "gender_filter");
  const enabled = premium?.catalogue?.premiumFiltersEnabled ?? premium !== null;
  const open = premium?.openUnlockSheet;
  const openUnlockSheet = useCallback(() => open?.(), [open]);
  return {
    unlocked: !enabled || expiresAt !== null,
    expiresAt,
    coins: premium?.wallet?.coins ?? 0,
    costPerDay: premium?.catalogue?.costPerDay ?? 0,
    enabled,
    openUnlockSheet,
  };
}
