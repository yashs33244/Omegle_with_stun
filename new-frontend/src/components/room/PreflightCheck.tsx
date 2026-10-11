import React from "react";
import { CheckCircle2, Lightbulb, Loader, Mic, Wifi, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePreflight, type NetworkCheck } from "@/hooks/usePreflight";

type NetworkKey = `preflight.network.${"checking" | "failed" | "blocked" | "direct" | "relay" | "maybeRelay"}`;

function networkText(network: NetworkCheck): { ok: boolean | null; key: NetworkKey } {
  if (network.status === "checking") return { ok: null, key: "preflight.network.checking" };
  if (network.status === "failed") return { ok: false, key: "preflight.network.failed" };
  const { host, srflx, relay } = network.result;
  if (!host && !srflx && !relay) return { ok: false, key: "preflight.network.blocked" };
  if (srflx) return { ok: true, key: "preflight.network.direct" };
  if (relay) return { ok: true, key: "preflight.network.relay" };
  return { ok: null, key: "preflight.network.maybeRelay" };
}

/**
 * Pre-flight check under the camera tile: mic meter, lighting hint and
 * network probe, in one compact row so the start screen stays one screen.
 */
export const PreflightCheck: React.FC<{ stream: MediaStream | null }> = ({ stream }) => {
  const { t } = useTranslation("room");
  const { micLevel, lighting, network } = usePreflight(stream);
  const net = networkText(network);
  const NetIcon = network.status === "checking" ? Loader : net.ok === false ? WifiOff : Wifi;
  const level = Math.round(micLevel * 100);

  return (
    <section aria-label={t("preflight.label")} className="text-xs text-gray-300 space-y-1" data-testid="preflight">
      <h2 className="sr-only">{t("preflight.title")}</h2>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 min-w-0 w-28 shrink-0">
          <Mic className="w-4 h-4 shrink-0" aria-hidden="true" />
          <div
            className="flex-1 h-1.5 bg-white/20 rounded"
            role="meter"
            aria-label={t("preflight.micLevel")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={level}
          >
            <div className="h-1.5 bg-green-400 rounded transition-all" style={{ width: `${level}%` }} />
          </div>
        </div>
        {lighting === "dark" && (
          <p className="flex items-center gap-1 text-yellow-300 min-w-0" role="status">
            <Lightbulb className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{t("preflight.dark")}</span>
          </p>
        )}
        {lighting === "ok" && (
          <p className="flex items-center gap-1 min-w-0">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-green-400" aria-hidden="true" />
            <span className="truncate">{t("preflight.lightingOk")}</span>
          </p>
        )}
      </div>
      <p
        className={`flex items-start gap-1 ${net.ok === false ? "text-red-300" : ""}`}
        role="status"
        data-testid="preflight-network"
      >
        <NetIcon className={`w-4 h-4 shrink-0 ${network.status === "checking" ? "animate-spin" : ""}`} aria-hidden="true" />
        <span>{t(net.key)}</span>
      </p>
    </section>
  );
};
