/**
 * Premium (coins + gender filter unlock). Mount contract:
 *   App.tsx:      <PremiumProvider> once inside the router (renders the UnlockSheet itself)
 *   RoomSession:  useWalletSync(signaling)
 *   Gender picker: useGenderFilterGate()
 */
export { PremiumProvider } from "./PremiumProvider";
export { usePremium } from "./PremiumContext";
export { useGenderFilterGate, type GenderFilterGate } from "./useGenderFilterGate";
export { useWalletSync } from "./useWalletSync";
export { UnlockSheet } from "./UnlockSheet";
