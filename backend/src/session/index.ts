/**
 * Builds the session gate from config and the server's shared pieces, so
 * server.ts only has to mount the router, the handshake, the queue gate and
 * the status broadcaster.
 */
import type Redis from "ioredis";
import { Counter, type Registry } from "prom-client";
import type { Config } from "../config";
import type { FlagsReader } from "../flags/flags";
import { createSessionRouter } from "../http/session";
import type { Logger } from "../logger";
import type { MatchStore } from "../store/MatchStore";
import { startMatchingBroadcast } from "./broadcast";
import { SALT_PURPOSE } from "./constants";
import { sessionHandshake } from "./handshake";
import { Lockout, MatchCaps, SessionRateLimiter, deriveSalt } from "./limits";
import { MemoryKv } from "./MemoryKv";
import { SessionQueueGate } from "./queueGate";
import { RedisKv } from "./RedisKv";
import { SessionService, type RestrictionChecker } from "./SessionService";
import { TokenSigner } from "./tokens";
import type { FetchLike } from "./turnstile";

export type { RestrictionChecker } from "./SessionService";
export type { QueueGate, QueueRefusal } from "./queueGate";
export { handshakeSession } from "./handshake";

export interface SessionFeatureDeps {
  config: Config;
  flags: FlagsReader;
  store: MatchStore;
  logger: Logger;
  registry: Registry;
  /** Shared Redis client in Redis mode; memory otherwise. */
  redis?: Redis;
  fetch?: FetchLike;
  restrictions?: RestrictionChecker;
}

export function createSessionFeature(deps: SessionFeatureDeps) {
  const { config, flags, logger } = deps;
  const secrets = [config.sessionSecret, ...(config.sessionSecretPrevious ? [config.sessionSecretPrevious] : [])];
  const tokens = new TokenSigner(secrets);
  const kv = deps.redis ? new RedisKv(deps.redis) : new MemoryKv();
  const salt = deriveSalt(config.sessionSecret, SALT_PURPOSE.limits);
  const caps = new MatchCaps(kv, salt, {
    perDevicePerHour: config.matchCapPerDevicePerHour,
    perIpPerHour: config.matchCapPerIpPerHour,
    perDevicePerMinute: config.matchCapPerDevicePerMin,
  });

  const sessionRequests = new Counter({
    name: "chizzy_session_requests_total",
    help: "POST /api/session results (issued or the error code)",
    labelNames: ["result"],
    registers: [deps.registry],
  });
  const handshakeRejected = new Counter({
    name: "chizzy_handshake_rejected_total",
    help: "Socket.IO connections refused by the session gate",
    labelNames: ["code"],
    registers: [deps.registry],
  });

  const service = new SessionService({
    tokens,
    flags,
    lockout: new Lockout(
      kv,
      secrets.map((s) => deriveSalt(s, SALT_PURPOSE.lockout)),
    ),
    rateLimiter: new SessionRateLimiter(kv, salt, {
      perIpPerMinute: config.sessionRatePerIpPerMin,
      perNetworkPerMinute: config.sessionRatePerNetworkPerMin,
    }),
    logger,
    turnstileSecret: config.turnstileSecret,
    fetch: deps.fetch ?? (fetch as unknown as FetchLike),
    restrictions: deps.restrictions,
    onResult: (result) => sessionRequests.inc({ result }),
  });

  return {
    tokens,
    caps,
    service,
    router: createSessionRouter({ config, flags, service, logger }),
    handshake: sessionHandshake({
      tokens,
      flags,
      caps,
      logger,
      trustCloudflare: config.trustCloudflare,
      proxyIpHeader: config.proxyIpHeader,
      onReject: (code) => handshakeRejected.inc({ code }),
    }),
    gate: new SessionQueueGate(flags, deps.store, caps, logger),
    startBroadcast: (io: Parameters<typeof startMatchingBroadcast>[0]) =>
      startMatchingBroadcast(io, flags, config.matchingStatusIntervalMs),
  };
}

/** Loud startup warnings for a gate that is weaker than production needs. */
export function sessionWarnings(config: Config): string[] {
  const warnings: string[] = [];
  if (!config.turnstileSecret) {
    warnings.push("Turnstile is OFF: POST /api/session does not check for bots (set TURNSTILE_SECRET)");
  }
  if (!config.trustCloudflare) {
    const msg = "TRUST_CLOUDFLARE is off: the country is unknown, so geo-blocking is OFF";
    warnings.push(config.nodeEnv === "production" ? `${msg} in production` : msg);
  }
  if (config.sessionSecretGenerated) {
    warnings.push(
      config.redisUrl
        ? "SESSION_SECRET is unset: each replica signs with its own random key, so tokens fail on other replicas"
        : "SESSION_SECRET is unset: using a random key, so tokens stop working when the process restarts",
    );
  }
  return warnings;
}
