/**
 * Forwards the socket's wallet pushes into the PremiumProvider. Mount once
 * where the signaling hook lives (RoomSession):
 *
 *   useWalletSync(signaling);
 *
 * wallet:update carries coins and unlocks (after hello, purchases, unlocks,
 * admin adjustments); coins:update carries the balance after an earned delta.
 */
import { useEffect } from "react";
import type { Signaling } from "@/hooks/useSignaling";
import { usePremium } from "./PremiumContext";

export function useWalletSync(signaling: Pick<Signaling, "subscribe">): void {
  const premium = usePremium();
  const applyWallet = premium?.applyWallet;
  const applyCoins = premium?.applyCoins;
  const { subscribe } = signaling;
  useEffect(() => {
    if (!applyWallet || !applyCoins) return;
    const offWallet = subscribe("wallet:update", applyWallet);
    const offCoins = subscribe("coins:update", (p) => applyCoins(p.balance));
    return () => {
      offWallet();
      offCoins();
    };
  }, [subscribe, applyWallet, applyCoins]);
}
