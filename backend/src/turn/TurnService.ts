/**
 * ICE servers and media caps for one matched call (protocol v3 call:start).
 *
 * TURN credentials are issued only here, per matched call, never at hello:
 * a hello-time credential would hand free relay to anyone who opens a socket.
 * Rules (LAUNCH_PLAN LB-8):
 * - flags.turn_enabled false, provider "none", over a cap or a provider error
 *   -> STUN only and privateModeAllowed false;
 * - one credential set per device is cached for TURN_CACHE_SECONDS, so fast
 *   Next presses do not mint a new set per call;
 * - new sets are capped per device and per IP (hashed) per hour.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Config } from "../config";
import type { FlagsReader } from "../flags/flags";
import type { Logger } from "../logger";
import type { MatchMetrics } from "../match/matchMetrics";
import type { IceServer } from "../protocol";
import { fetchCloudflareIceServers, type FetchFn } from "./cloudflare";
import {
  CAP_WINDOW_MS,
  CREDENTIAL_RESULT,
  DEVICE_IP_TTL_MS,
  IP_KEY_DOMAIN,
  IP_KEY_HEX_CHARS,
  IP_SECRET_BYTES,
  SECOND_MS,
} from "./constants";
import { buildIceServers } from "./coturn";
import type { TurnStore } from "./store";

export interface CallMedia {
  iceServers: IceServer[];
  maxBitrateKbps: number;
  relayMaxBitrateKbps: number;
  privateModeAllowed: boolean;
}

export interface TurnServiceDeps {
  config: Config;
  flags: FlagsReader;
  store: TurnStore;
  logger: Logger;
  metrics: Pick<MatchMetrics, "turnCredentialsTotal">;
  fetch?: FetchFn;
  now?: () => number;
}

/**
 * Keyed hash used for the per-IP counter, so raw IPs are never stored and a
 * stored key cannot be reversed by hashing every IPv4 address. The key is a
 * secret every instance shares (the TURN API token or secret); without one it
 * is random per process, which makes the IP cap per instance.
 */
export function ipKey(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(`${IP_KEY_DOMAIN}${ip}`).digest("hex").slice(0, IP_KEY_HEX_CHARS);
}

export class TurnService {
  private readonly config: Config;
  private readonly flags: FlagsReader;
  private readonly store: TurnStore;
  private readonly log: Logger;
  private readonly metrics: TurnServiceDeps["metrics"];
  private readonly fetch: FetchFn;
  private readonly now: () => number;
  private readonly ipSecret: string;
  /** Requests in flight per device on this instance, so concurrent calls share one API request. */
  private readonly inflight = new Map<string, Promise<IceServer[] | null>>();

  constructor(deps: TurnServiceDeps) {
    this.config = deps.config;
    this.flags = deps.flags;
    this.store = deps.store;
    this.log = deps.logger;
    this.metrics = deps.metrics;
    this.fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
    this.ipSecret =
      this.config.cfTurnApiToken ?? this.config.turnSecret ?? randomBytes(IP_SECRET_BYTES).toString("hex");
  }

  /** For the hello ack: STUN only. */
  stunServers(): IceServer[] {
    return this.config.stunUrls.length > 0 ? [{ urls: [...this.config.stunUrls] }] : [];
  }

  /** Remembers which IP (hashed) a device said hello from, for the per-IP cap. */
  async rememberIp(deviceId: string, ip: string): Promise<void> {
    if (this.config.turnProvider === "none") return;
    await this.store.setDeviceIp(deviceId, ipKey(ip, this.ipSecret), DEVICE_IP_TTL_MS);
  }

  async callMedia(deviceId: string): Promise<CallMedia> {
    const flags = this.flags.current();
    const relay = await this.relayServers(deviceId);
    return {
      iceServers: relay ? [...this.stunServers(), ...relay] : this.stunServers(),
      maxBitrateKbps: flags.video_max_kbps,
      relayMaxBitrateKbps: flags.relay_video_max_kbps,
      privateModeAllowed: relay !== null && flags.private_mode_enabled && flags.turn_enabled,
    };
  }

  /** TURN servers for this device, or null for STUN only. Never throws. */
  private async relayServers(deviceId: string): Promise<IceServer[] | null> {
    if (this.config.turnProvider === "none") return null;
    if (!this.flags.current().turn_enabled) {
      this.metrics.turnCredentialsTotal.inc({ result: CREDENTIAL_RESULT.disabled });
      return null;
    }
    const pending = this.inflight.get(deviceId);
    if (pending) return pending;
    const p = this.issue(deviceId).finally(() => this.inflight.delete(deviceId));
    this.inflight.set(deviceId, p);
    return p;
  }

  private async issue(deviceId: string): Promise<IceServer[] | null> {
    try {
      const cached = await this.store.getCached(deviceId);
      if (cached) {
        this.metrics.turnCredentialsTotal.inc({ result: CREDENTIAL_RESULT.cached });
        return cached;
      }
      const perDevice = await this.store.hit(`dev:${deviceId}`, CAP_WINDOW_MS);
      const ipHash = await this.store.getDeviceIp(deviceId);
      const perIp = ipHash ? await this.store.hit(`ip:${ipHash}`, CAP_WINDOW_MS) : 0;
      if (perDevice > this.config.turnMaxPerDeviceHour || perIp > this.config.turnMaxPerIpHour) {
        this.metrics.turnCredentialsTotal.inc({ result: CREDENTIAL_RESULT.capped });
        this.log.warn({ perDevice, perIp }, "TURN credential cap reached; STUN only");
        return null;
      }
      const servers = await this.generate(deviceId);
      if (!servers || servers.length === 0) return null;
      await this.store.setCached(deviceId, servers, this.config.turnCacheSeconds * SECOND_MS);
      this.metrics.turnCredentialsTotal.inc({ result: CREDENTIAL_RESULT.issued });
      return servers;
    } catch (err) {
      this.metrics.turnCredentialsTotal.inc({ result: CREDENTIAL_RESULT.error });
      this.log.error({ err }, "TURN credentials failed; STUN only");
      return null;
    }
  }

  private async generate(deviceId: string): Promise<IceServer[] | null> {
    const c = this.config;
    switch (c.turnProvider) {
      case "cloudflare":
        return fetchCloudflareIceServers({
          keyId: c.cfTurnKeyId!,
          apiToken: c.cfTurnApiToken!,
          ttlSeconds: c.turnTtlSeconds,
          fetch: this.fetch,
        });
      case "secret":
      case "static":
        // buildIceServers adds the STUN entry first; keep only the TURN part.
        return buildIceServers({ ...c, stunUrls: [] }, deviceId, this.now());
      default:
        return null;
    }
  }
}
