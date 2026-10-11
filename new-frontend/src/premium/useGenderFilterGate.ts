// replaced by the billing lane: this stub keeps the gender filter free until
// the coin-based unlock ships. The signature is the contract UxShell codes
// against; keep it in sync with the billing implementation.

export interface GenderFilterGate {
  /** The paid gender filter is active for this session. */
  unlocked: boolean;
  /** When the current unlock ends (ms since epoch), null while locked or unlimited. */
  expiresAt: number | null;
  /** Coins this device holds. */
  coins: number;
  /** Coins one day of gender filter costs (operator flag). */
  costPerDay: number;
  /** The premium feature is switched on by the operator at all. */
  enabled: boolean;
  /** Opens the unlock sheet (coin packs / spend coins). */
  openUnlockSheet: () => void;
}

const FREE: GenderFilterGate = {
  unlocked: true,
  expiresAt: null,
  coins: 0,
  costPerDay: 0,
  enabled: false,
  openUnlockSheet() {},
};

export function useGenderFilterGate(): GenderFilterGate {
  return FREE;
}
