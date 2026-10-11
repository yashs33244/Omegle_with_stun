/**
 * <SparkCard spark={useSpark(...)} />
 *
 * The prompt card both sides see for SPARK.cardMs, rendered once near the
 * room root (fixed, above the video). While a modal sheet is open the card
 * waits out of sight (it would be inert above the sheet) and shows once the
 * sheet closes. Shows the prompt in the viewer's UI
 * language, who sparked it, "Another" (a new request, disabled while the
 * room cooldown runs) and a dismiss button. data-testid="spark-card" with
 * data-prompt-id; the prompt text is in data-testid="spark-text".
 */
import React, { useEffect, useState } from "react";
import { X, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/retroui/Button";
import { SPARK } from "@/lib/protocol";
import type { SparkHandle } from "./useSpark";
import { useCountdown } from "./useCountdown";

export interface SparkCardProps {
  spark: SparkHandle;
}

export const SparkCard: React.FC<SparkCardProps> = ({ spark }) => {
  const { t } = useTranslation("spark");
  const remaining = useCountdown(spark.cooldownUntil, 250);
  const card = spark.card;
  // The bar starts full and shrinks to nothing over the card's life.
  const [barFull, setBarFull] = useState(true);
  useEffect(() => {
    if (!card || spark.held) return;
    setBarFull(true);
    const frame = requestAnimationFrame(() => setBarFull(false));
    return () => cancelAnimationFrame(frame);
  }, [card, spark.held]);

  if (!card || spark.held) return null;
  const cooling = remaining > 0;
  const text = spark.text === null ? t("card.loading") : spark.text || t("card.unavailable");

  return (
    // Phones: left of the local picture-in-picture column (and the landscape rail); desktop: centred.
    <div
      role="status"
      aria-live="polite"
      data-testid="spark-card"
      data-prompt-id={card.promptId}
      data-from={card.from}
      className="fixed left-3 right-[7.5rem] z-[60] overflow-hidden rounded-xl border-2 border-black bg-gray-900/95 text-white shadow-[4px_4px_0_0_#000] max-lg:landscape:right-auto max-lg:landscape:w-[min(28rem,50vw)] lg:left-1/2 lg:right-auto lg:w-[calc(100%-1.5rem)] lg:max-w-md lg:-translate-x-1/2"
      style={{ top: "max(4rem, env(safe-area-inset-top))" }}
    >
      <div className="flex items-start gap-3 p-4">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-yellow-400 text-black">
          <Zap className="h-4 w-4" aria-hidden="true" fill="currentColor" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-yellow-400">
            {t("card.heading")} · {card.from === "you" ? t("card.fromYou") : t("card.fromPartner")}
          </p>
          <p data-testid="spark-text" className="mt-1 text-lg font-medium leading-snug">
            {text}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={spark.request}
              disabled={cooling || !spark.ready}
              data-testid="spark-another"
              className="min-h-[44px] rounded-lg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow"
            >
              {cooling ? t("button.cooldown", { seconds: Math.ceil(remaining / 1000) }) : t("card.another")}
            </Button>
          </div>
        </div>
        <button
          type="button"
          onClick={spark.dismiss}
          aria-label={t("card.dismiss")}
          data-testid="spark-dismiss"
          className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-300 hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-yellow-400"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      <div
        className="h-1 bg-yellow-400"
        style={{ width: barFull ? "100%" : "0%", transition: barFull ? "none" : `width ${SPARK.cardMs}ms linear` }}
        aria-hidden="true"
      />
    </div>
  );
};
