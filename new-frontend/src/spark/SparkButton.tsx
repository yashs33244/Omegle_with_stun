/**
 * <SparkButton spark={useSpark(...)} />
 *
 * A 44 px lightning button that asks the server for an icebreaker both sides
 * see at once. While the room cooldown runs it is disabled and draws a ring
 * that empties as the cooldown passes. data-testid="spark-button";
 * data-cooldown="1" while cooling.
 */
import React from "react";
import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SPARK } from "@/lib/protocol";
import { cn } from "@/lib/utils";
import type { SparkHandle } from "./useSpark";
import { useCountdown } from "./useCountdown";

const RING_RADIUS = 20;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export interface SparkButtonProps {
  spark: SparkHandle;
  className?: string;
}

export const SparkButton: React.FC<SparkButtonProps> = ({ spark, className }) => {
  const { t } = useTranslation("spark");
  const remaining = useCountdown(spark.cooldownUntil);
  const cooling = remaining > 0;
  const disabled = !spark.ready || cooling;
  const seconds = Math.ceil(remaining / 1000);
  const title = cooling ? t("button.cooldown", { seconds }) : t("button.title");

  return (
    <button
      type="button"
      onClick={spark.request}
      disabled={disabled}
      aria-label={t("button.label")}
      title={title}
      data-testid="spark-button"
      data-cooldown={cooling ? "1" : undefined}
      className={cn(
        "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-black text-black shadow-[2px_2px_0_0_#000] transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400",
        cooling || spark.pending ? "bg-gray-700 text-gray-300" : "bg-yellow-400 hover:bg-yellow-300",
        !spark.ready && !cooling && "opacity-60",
        className,
      )}
    >
      <Zap className="h-5 w-5" aria-hidden="true" fill={cooling ? "none" : "currentColor"} />
      {cooling && (
        <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 44 44" aria-hidden="true">
          <circle
            cx="22"
            cy="22"
            r={RING_RADIUS}
            fill="none"
            stroke="#facc15"
            strokeWidth="3"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - remaining / SPARK.cooldownMs)}
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
};
