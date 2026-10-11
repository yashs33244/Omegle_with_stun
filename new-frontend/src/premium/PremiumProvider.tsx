// replaced by the billing lane: the real provider loads the wallet, mounts
// <UnlockSheet/> once near the app root and feeds useGenderFilterGate().
import type React from "react";

export const PremiumProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => <>{children}</>;
