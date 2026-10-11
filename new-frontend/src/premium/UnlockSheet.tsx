/**
 * Bottom sheet (dialog on desktop) for the gender filter: coin balance,
 * unlock for 1/7/30 days, buy a coin pack through Razorpay Checkout.
 * Rendered by PremiumProvider while `sheetOpen`; opened with
 * useGenderFilterGate().openUnlockSheet(). Built on BottomSheet so it stacks
 * over the settings sheet that opens it (Radix layers both dialogs).
 */
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Coins, Lock, Unlock } from "lucide-react";
import { BottomSheet } from "@/components/ui/BottomSheet";
import type { CoinPack, UnlockDays } from "@/lib/protocol";
import { unlockFor, usePremium, type PremiumErrorKey } from "./PremiumContext";

type Feedback = { tone: "ok" | "error"; text: string } | null;

const PRIMARY =
  "retro-button min-h-[44px] shrink-0 rounded-xl bg-yellow-400 px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY =
  "min-h-[44px] w-full rounded-xl border-2 border-black bg-gray-700 px-3 py-2 text-sm font-semibold text-white shadow-[2px_2px_0_0_#000] hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:cursor-not-allowed disabled:opacity-50";

export const UnlockSheet: React.FC = () => {
  const { t, i18n } = useTranslation("premium");
  const premium = usePremium();
  const [feedback, setFeedback] = useState<Feedback>(null);

  if (!premium) return null;
  const { catalogue, wallet, busy } = premium;
  const coins = wallet?.coins ?? null;
  const expiresAt = unlockFor(wallet, "gender_filter");
  const costPerDay = catalogue?.costPerDay ?? 0;
  const days: readonly UnlockDays[] = catalogue?.unlockDays ?? [1, 7, 30];
  const packs: CoinPack[] = catalogue?.packs ?? [];
  const fail = (error: PremiumErrorKey) => setFeedback({ tone: "error", text: t(`errors.${error}`) });

  const unlock = async (d: UnlockDays) => {
    setFeedback(null);
    const result = await premium.unlock("gender_filter", d);
    if (result.ok) setFeedback({ tone: "ok", text: t("unlockedToast") });
    else fail(result.error);
  };

  const buy = async (packId: string) => {
    setFeedback(null);
    const result = await premium.buy(packId);
    if (result.ok) setFeedback({ tone: "ok", text: t("creditedToast") });
    else fail(result.error);
  };

  const formatDate = (ms: number) => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(ms);

  return (
    <BottomSheet
      open
      onOpenChange={(open) => {
        if (!open && busy === null) premium.closeUnlockSheet();
      }}
      title={
        <span className="flex items-center gap-2">
          {expiresAt ? (
            <Unlock className="h-5 w-5 text-green-400" aria-hidden="true" />
          ) : (
            <Lock className="h-5 w-5 text-yellow-400" aria-hidden="true" />
          )}
          {t("title")}
        </span>
      }
      description={t("intro")}
      closeLabel={t("close")}
      data-testid="unlock-sheet"
      footer={
        <button
          type="button"
          onClick={premium.closeUnlockSheet}
          disabled={busy !== null}
          data-testid="unlock-close"
          className={`${PRIMARY} w-full`}
        >
          {t("close")}
        </button>
      }
    >
      <div className="flex items-center justify-between rounded-xl border-2 border-black bg-gray-900 px-4 py-3">
        <span className="flex items-center gap-2 text-sm text-gray-300">
          <Coins className="h-5 w-5 text-yellow-400" aria-hidden="true" />
          {t("balanceLabel")}
        </span>
        <span className="text-xl font-bold text-yellow-400" data-testid="wallet-coins" aria-live="polite">
          {coins === null ? "--" : t("balance", { coins })}
        </span>
      </div>
      <p className="mt-2 text-xs text-gray-400" data-testid="unlock-status">
        {expiresAt ? t("statusUnlocked", { date: formatDate(expiresAt) }) : t("statusLocked")}
      </p>

      <section className="mt-5" aria-labelledby="unlock-heading">
        <h3 id="unlock-heading" className="mb-2 text-sm font-medium">
          {t("unlockHeading")}
        </h3>
        <div className="grid grid-cols-3 gap-2">
          {days.map((d) => {
            const cost = costPerDay * d;
            const affordable = coins !== null && coins >= cost;
            return (
              <button
                key={d}
                type="button"
                onClick={() => void unlock(d)}
                disabled={busy !== null || !affordable || costPerDay === 0}
                data-testid={`unlock-${d}`}
                className={`${SECONDARY} flex flex-col items-center gap-0.5`}
              >
                <span>{t("days", { count: d })}</span>
                <span className={`text-xs ${affordable ? "text-yellow-400" : "text-gray-400"}`}>
                  {affordable || coins === null ? t("costCoins", { coins: cost }) : t("notEnough")}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="mt-5" aria-labelledby="buy-heading">
        <h3 id="buy-heading" className="mb-2 text-sm font-medium">
          {t("buyHeading")}
        </h3>
        {catalogue && !catalogue.enabled ? (
          <p className="text-sm text-gray-400" data-testid="buy-disabled">
            {t("disabled")}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {packs.map((pack) => (
              <div key={pack.id} className="flex items-center justify-between gap-3 rounded-xl border-2 border-black bg-gray-900 p-3">
                <div>
                  <p className="whitespace-nowrap font-semibold">{t("packCoins", { coins: pack.coins })}</p>
                  {costPerDay > 0 && (
                    <p className="text-xs text-gray-400">{t("packDays", { days: Math.floor(pack.coins / costPerDay) })}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void buy(pack.id)}
                  disabled={busy !== null || !catalogue}
                  data-testid={`buy-${pack.id}`}
                  className={`${PRIMARY} min-w-[5.5rem]`}
                >
                  {busy === "buy" ? t("paying") : t("packPrice", { inr: pack.inr })}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {feedback && (
        <p role="status" data-testid="premium-feedback" className={`mt-4 text-sm ${feedback.tone === "ok" ? "text-green-400" : "text-red-400"}`}>
          {feedback.text}
        </p>
      )}
      <p className="mt-4 text-xs text-gray-500">{t("earnHint")}</p>
    </BottomSheet>
  );
};
