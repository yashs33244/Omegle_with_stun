import React from "react";
import { CheckCircle2, Lightbulb, Loader, Mic, Wifi, WifiOff } from "lucide-react";
import { usePreflight, type NetworkCheck } from "@/hooks/usePreflight";

function networkText(network: NetworkCheck): { ok: boolean | null; text: string } {
  if (network.status === "checking") return { ok: null, text: "Checking your network..." };
  if (network.status === "failed") return { ok: false, text: "Could not check your network." };
  const { host, srflx, relay } = network.result;
  if (!host && !srflx && !relay) return { ok: false, text: "Video calls look blocked on this network." };
  if (srflx) return { ok: true, text: "Network OK for direct video." };
  if (relay) return { ok: true, text: "Network OK through our relay." };
  return { ok: null, text: "Your network may need our relay; we try it when you match." };
}

/** Pre-flight check on the start screen: mic meter, lighting hint and network probe. */
export const PreflightCheck: React.FC<{ stream: MediaStream | null }> = ({ stream }) => {
  const { micLevel, lighting, network } = usePreflight(stream);
  const net = networkText(network);
  const NetIcon = network.status === "checking" ? Loader : net.ok === false ? WifiOff : Wifi;

  return (
    <section aria-label="Pre-flight check" className="space-y-2 text-sm" data-testid="preflight">
      <h2 className="font-medium text-sm">Before you start</h2>
      <div className="flex items-center gap-2">
        <Mic className="w-4 h-4 shrink-0" aria-hidden="true" />
        <div
          className="flex-1 h-2 bg-white bg-opacity-20 rounded"
          role="meter"
          aria-label="Microphone level"
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
          Your camera looks dark. Face a light so your partner can see you.
        </p>
      )}
      {lighting === "ok" && (
        <p className="flex items-center gap-2 text-gray-300">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-green-400" aria-hidden="true" />
          Lighting looks fine.
        </p>
      )}
      <p className={`flex items-center gap-2 ${net.ok === false ? "text-red-300" : "text-gray-300"}`} role="status" data-testid="preflight-network">
        <NetIcon className={`w-4 h-4 shrink-0 ${network.status === "checking" ? "animate-spin" : ""}`} aria-hidden="true" />
        {net.text}
      </p>
    </section>
  );
};
