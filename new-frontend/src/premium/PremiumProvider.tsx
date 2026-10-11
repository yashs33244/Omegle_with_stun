/**
 * Owns the coin wallet and the premium catalogue for the app, and renders the
 * UnlockSheet once. Mount it once, inside the router:
 *
 *   <PremiumProvider><Routes .../></PremiumProvider>
 *
 * The wallet arrives over the socket (wallet:update after session:hello,
 * forwarded by useWalletSync in the room) and over REST when the sheet opens.
 * A paid Checkout that /verify has not credited yet is kept in localStorage
 * and retried here, including after a reload (pendingPayment.ts).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/lib/api";
import { billingApi as defaultBillingApi, type BillingApi } from "@/lib/billingApi";
import type { BillingPacksResponse, PremiumFeature, UnlockDays, WalletView } from "@/lib/protocol";
import { getSessionToken } from "@/lib/session";
import { ERROR_KEYS, PremiumContext, type PremiumErrorKey, type PremiumOutcome, type PremiumValue } from "./PremiumContext";
import {
  attemptVerify,
  clearPendingPayment,
  loadPendingPayment,
  savePendingPayment,
  settlePendingPayment,
  type PendingPayment,
  type SettleHandle,
} from "./pendingPayment";
import { openCheckout as defaultOpenCheckout } from "./razorpayCheckout";
import { UnlockSheet } from "./UnlockSheet";

interface PremiumProviderProps {
  children: React.ReactNode;
  /** Injection points for tests. */
  api?: BillingApi;
  openCheckout?: typeof defaultOpenCheckout;
}

/** A server that answered with the wrong shape is "generic"; everything else thrown here is a network problem (API, checkout.js). */
function thrownErrorKey(err: unknown): PremiumErrorKey {
  return err instanceof ApiError && err.status !== null ? "generic" : "unreachable";
}

export const PremiumProvider: React.FC<PremiumProviderProps> = ({ children, api = defaultBillingApi, openCheckout = defaultOpenCheckout }) => {
  const { t } = useTranslation("premium");
  const [catalogue, setCatalogue] = useState<BillingPacksResponse | null>(null);
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState<"buy" | "unlock" | null>(null);
  const [pending, setPending] = useState(false);
  const catalogueLoad = useRef<Promise<void> | null>(null);
  const settling = useRef<SettleHandle | null>(null);

  const loadCatalogue = useCallback(() => {
    catalogueLoad.current ??= api
      .getPacks()
      .then(setCatalogue)
      .catch(() => {
        catalogueLoad.current = null; // retry on the next refresh
      });
    return catalogueLoad.current;
  }, [api]);

  const loadWallet = useCallback(async () => {
    const token = getSessionToken();
    if (!token) return;
    const res = await api.getWallet(token).catch(() => null);
    if (res?.ok) setWallet({ coins: res.coins, unlocks: res.unlocks });
  }, [api]);

  const refresh = useCallback(async () => {
    await Promise.all([loadCatalogue(), loadWallet()]);
  }, [loadCatalogue, loadWallet]);

  useEffect(() => {
    void loadCatalogue();
  }, [loadCatalogue]);

  /** Keeps retrying a paid Checkout until the server credits or refuses it; one loop at a time. */
  const settle = useCallback(
    (payment: PendingPayment, alreadyTried = false) => {
      settling.current?.cancel();
      const handle = settlePendingPayment(payment, { api, getToken: getSessionToken, alreadyTried });
      settling.current = handle;
      setPending(true);
      void handle.done.then((result) => {
        if (settling.current !== handle) return;
        settling.current = null;
        setPending(false);
        if (result.status === "ok") setWallet((w) => ({ coins: result.coins, unlocks: w?.unlocks ?? [] }));
      });
    },
    [api],
  );

  // A payment left over from an earlier page (closed tab, reload) is settled on load.
  useEffect(() => {
    const leftover = loadPendingPayment();
    if (leftover) settle(leftover);
    return () => {
      settling.current?.cancel();
      settling.current = null;
    };
  }, [settle]);

  const openUnlockSheet = useCallback(() => {
    setSheetOpen(true);
    void refresh();
  }, [refresh]);
  const closeUnlockSheet = useCallback(() => setSheetOpen(false), []);

  const applyWallet = useCallback((view: WalletView) => setWallet(view), []);
  const applyCoins = useCallback((balance: number) => setWallet((w) => ({ coins: balance, unlocks: w?.unlocks ?? [] })), []);

  const unlock = useCallback(
    async (feature: PremiumFeature, days: UnlockDays): Promise<PremiumOutcome> => {
      const token = getSessionToken();
      if (!token) return { ok: false, error: "sessionRequired" };
      setBusy("unlock");
      try {
        const res = await api.unlock(token, { feature, days });
        if (!res.ok) return { ok: false, error: ERROR_KEYS[res.error] };
        setWallet((w) => ({
          coins: res.coins,
          unlocks: [...(w?.unlocks ?? []).filter((u) => u.feature !== feature), { feature, expiresAt: res.expiresAt }],
        }));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: thrownErrorKey(err) };
      } finally {
        setBusy(null);
      }
    },
    [api],
  );

  const buy = useCallback(
    async (packId: string): Promise<PremiumOutcome> => {
      const token = getSessionToken();
      if (!token) return { ok: false, error: "sessionRequired" };
      setBusy("buy");
      try {
        const order = await api.createOrder(token, packId);
        if (!order.ok) return { ok: false, error: ERROR_KEYS[order.error] };
        const result = await openCheckout(order, { name: "Chizzy", description: t("packCoins", { coins: order.coins }) });
        if (result.status === "dismissed") return { ok: false, error: "dismissed" };
        if (result.status === "failed") return { ok: false, error: "paymentFailed" };
        // From here on the user has paid: the proof survives until /verify answers.
        const payment: PendingPayment = { orderId: order.orderId, paymentId: result.paymentId, signature: result.signature, startedAt: Date.now() };
        savePendingPayment(payment);
        const verified = await attemptVerify(api, token, payment);
        if (verified.status === "ok") {
          clearPendingPayment();
          setWallet((w) => ({ coins: verified.coins, unlocks: w?.unlocks ?? [] }));
          return { ok: true };
        }
        if (verified.status === "failed") {
          clearPendingPayment();
          return { ok: false, error: verified.error };
        }
        settle(payment, true);
        return { ok: false, error: "paymentPending" };
      } catch (err) {
        return { ok: false, error: thrownErrorKey(err) };
      } finally {
        setBusy(null);
      }
    },
    [api, openCheckout, settle, t],
  );

  const value = useMemo<PremiumValue>(
    () => ({ catalogue, wallet, sheetOpen, busy, pending, openUnlockSheet, closeUnlockSheet, refresh, applyWallet, applyCoins, unlock, buy }),
    [catalogue, wallet, sheetOpen, busy, pending, openUnlockSheet, closeUnlockSheet, refresh, applyWallet, applyCoins, unlock, buy],
  );

  return (
    <PremiumContext.Provider value={value}>
      {children}
      {sheetOpen && <UnlockSheet />}
    </PremiumContext.Provider>
  );
};
