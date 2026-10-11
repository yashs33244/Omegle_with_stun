/**
 * Coins, premium unlocks and the unlock sheet, shared by the whole app.
 * Provided by PremiumProvider; read with usePremium() (null outside it, so
 * tests can render pieces without the provider).
 */
import { createContext, useContext } from "react";
import type { BillingError, BillingPacksResponse, PremiumFeature, UnlockDays, WalletView } from "@/lib/protocol";

export type PremiumErrorKey =
  | "paymentFailed"
  | "dismissed"
  | "unreachable"
  | "insufficientCoins"
  | "rateLimited"
  | "sessionRequired"
  | "generic";

/** What a Buy or Unlock press ended with. */
export type PremiumOutcome = { ok: true } | { ok: false; error: PremiumErrorKey };

export interface PremiumState {
  /** Catalogue from GET /api/billing/packs; null until loaded. */
  catalogue: BillingPacksResponse | null;
  /** Coins and active unlocks; null until the socket or REST told us. */
  wallet: WalletView | null;
  sheetOpen: boolean;
  /** A Buy or Unlock in flight; the sheet disables its buttons meanwhile. */
  busy: "buy" | "unlock" | null;
}

export interface PremiumValue extends PremiumState {
  openUnlockSheet: () => void;
  closeUnlockSheet: () => void;
  /** Reloads the catalogue and (with a session) the wallet. */
  refresh: () => Promise<void>;
  /** Socket pushes: wallet:update and coins:update. */
  applyWallet: (view: WalletView) => void;
  applyCoins: (balance: number) => void;
  unlock: (feature: PremiumFeature, days: UnlockDays) => Promise<PremiumOutcome>;
  buy: (packId: string) => Promise<PremiumOutcome>;
}

export const PremiumContext = createContext<PremiumValue | null>(null);

export function usePremium(): PremiumValue | null {
  return useContext(PremiumContext);
}

export function unlockFor(wallet: WalletView | null, feature: PremiumFeature, now = Date.now()): number | null {
  const unlock = wallet?.unlocks.find((u) => u.feature === feature);
  return unlock && unlock.expiresAt > now ? unlock.expiresAt : null;
}

export const ERROR_KEYS: Record<BillingError, PremiumErrorKey> = {
  billing_disabled: "generic",
  session_required: "sessionRequired",
  invalid: "generic",
  rate_limited: "rateLimited",
  unknown_pack: "generic",
  order_not_found: "generic",
  bad_signature: "paymentFailed",
  payment_mismatch: "paymentFailed",
  insufficient_coins: "insufficientCoins",
  upstream: "unreachable",
};
