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

/** Pre-flight check on the start screen: mic meter, lighting hint and network probe. */
export const PreflightCheck: React.FC<{ stream: MediaStream | null }> = ({ stream }) => {
  const { t } = useTranslation("room");
  const { micLevel, lighting, network } = usePreflight(stream);
  const net = networkText(network);
  const NetIcon = network.status === "checking" ? Loader : net.ok === false ? WifiOff : Wifi;

  return (
    <section aria-label={t("preflight.label")} className="space-y-2 text-sm" data-testid="preflight">
      <h2 className="font-medium text-sm">{t("preflight.title")}</h2>
      <div className="flex items-center gap-2">
        <Mic className="w-4 h-4 shrink-0" aria-hidden="true" />
        <div
          className="flex-1 h-2 bg-white bg-opacity-20 rounded"
          role="meter"
          aria-label={t("preflight.micLevel")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(micLevel * 100)}
        >
          <div className="h-2 bg-green-400 rounded transition-all" style={{ width: `${Math.round(micLevel * 100)}%` }} />
        </div>
      </div>
      {lighting === "dark" && (
        <p className="flex items-center gap-2 text-yellow-300" role="status">
          <Lightbulb className="w-4 h-4 shrink-0" aria-hidden="true" />
          {t("preflight.dark")}
        </p>
      )}
      {lighting === "ok" && (
        <p className="flex items-center gap-2 text-gray-300">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-green-400" aria-hidden="true" />
          {t("preflight.lightingOk")}
        </p>
      )}
      <p className={`flex items-center gap-2 ${net.ok === false ? "text-red-300" : "text-gray-300"}`} role="status" data-testid="preflight-network">
        <NetIcon className={`w-4 h-4 shrink-0 ${network.status === "checking" ? "animate-spin" : ""}`} aria-hidden="true" />
        {t(net.key)}
      </p>
    </section>
  );
};
