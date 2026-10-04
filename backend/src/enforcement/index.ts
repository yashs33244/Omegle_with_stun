/**
 * Builds the enforcement service from config. Memory store without Redis,
 * Redis store on the server's shared client otherwise; evidence on S3 when a
 * bucket is configured, else in EVIDENCE_DIR.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type Redis from "ioredis";
import type { Config } from "../config";
import type { Logger } from "../logger";
import { EnforcementService } from "./EnforcementService";
import { createS3EvidenceStore, FsEvidenceStore, type EvidenceStore } from "./evidence";
import type { FrameClassifier } from "./policy";
import { MemoryEnforcementStore, RedisEnforcementStore, type EnforcementStore } from "./store";
import { createTurnstileVerifier, type TurnstileVerifier } from "./turnstile";

export { EnforcementService } from "./EnforcementService";
export type { RestrictionSink } from "./EnforcementService";

/** Test and integration overrides. */
export interface EnforcementOptions {
  store?: EnforcementStore;
  evidence?: EvidenceStore;
  turnstile?: TurnstileVerifier;
  /** Server-side frame classifier hook (none ships in v1). */
  classifier?: FrameClassifier;
  /** fetch used by the default Turnstile verifier. */
  fetch?: typeof fetch;
  now?: () => number;
}

function pseudonymSalt(config: Config): string {
  if (config.pseudonymSalt) return config.pseudonymSalt;
  // Stable across restarts and instances as long as the admin token is.
  return createHash("sha256").update(`chizzy-pseudonym:${config.adminToken ?? "development"}`).digest("hex");
}

export function createEnforcement(
  config: Config,
  deps: { logger: Logger; redis?: Redis },
  opts: EnforcementOptions = {},
): EnforcementService {
  const store = opts.store ?? (deps.redis ? new RedisEnforcementStore(deps.redis) : new MemoryEnforcementStore());
  const evidence =
    opts.evidence ??
    (config.evidenceS3Bucket
      ? createS3EvidenceStore(config.evidenceS3Bucket, config.evidenceS3Region, config.evidenceS3KmsKeyId)
      : new FsEvidenceStore(resolve(config.evidenceDir)));
  const turnstile =
    opts.turnstile ??
    createTurnstileVerifier({
      secret: config.turnstileSecretKey,
      production: config.nodeEnv === "production",
      fetch: opts.fetch,
    });
  return new EnforcementService({
    store,
    evidence,
    turnstile,
    logger: deps.logger.child({ module: "enforcement" }),
    pseudonymSalt: pseudonymSalt(config),
    reportAfterEndMs: config.reportAfterEndMs,
    classifier: opts.classifier,
    now: opts.now,
  });
}
