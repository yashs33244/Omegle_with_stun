/**
 * Environment configuration, parsed once at startup with zod.
 * Invalid configuration fails fast with a readable message (see loadConfig).
 * Every variable is documented in backend/.env.example.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const int = (min: number) => z.coerce.number().int().min(min);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: int(0).max(65535).default(3004),
    CORS_ORIGINS: z.string().optional(),
    REDIS_URL: z.string().url().optional(),
    TRUST_PROXY: bool.default("false"),
    MAX_CONNECTIONS_PER_IP: int(1).default(10),
    MATCH_ACCEPT_TIMEOUT_MS: int(1000).default(30000),
    STUN_URLS: z.string().default("stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"),
    TURN_URLS: z.string().optional(),
    TURN_SECRET: z.string().min(1).optional(),
    TURN_USERNAME: z.string().min(1).optional(),
    TURN_CREDENTIAL: z.string().min(1).optional(),
    TURN_TTL_SECONDS: int(60).default(43200),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    METRICS_TOKEN: z.string().min(1).optional(),
    SHUTDOWN_GRACE_MS: int(0).default(10000),
    ADMIN_TOKEN: z.string().min(24, "must be at least 24 characters").optional(),
    ADMIN_ALLOWED_IPS: z.string().optional(),
    EVIDENCE_DIR: z.string().default("./data/evidence"),
    EVIDENCE_S3_BUCKET: z.string().min(3).optional(),
    EVIDENCE_S3_REGION: z.string().min(1).optional(),
    EVIDENCE_S3_KMS_KEY_ID: z.string().min(1).optional(),
    PSEUDONYM_SALT: z.string().min(16).optional(),
    TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    const origins = csv(env.CORS_ORIGINS);
    if (env.NODE_ENV === "production" && !env.ADMIN_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ADMIN_TOKEN"],
        message: "is required in production (the admin API stays closed without it)",
      });
    }
    if (env.NODE_ENV === "production") {
      if (origins.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CORS_ORIGINS"],
          message: "is required in production (comma separated list of allowed origins)",
        });
      } else if (origins.includes("*")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CORS_ORIGINS"],
          message: "must not contain * in production",
        });
      }
    }
    for (const origin of origins) {
      if (origin !== "*" && !/^https?:\/\/[^/\s]+$/.test(origin)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CORS_ORIGINS"],
          message: `invalid origin "${origin}" (expected scheme://host[:port] without a path)`,
        });
      }
    }
    if ((env.TURN_SECRET || env.TURN_USERNAME) && csv(env.TURN_URLS).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURN_URLS"],
        message: "is required when TURN_SECRET or TURN_USERNAME is set",
      });
    }
    if (Boolean(env.TURN_USERNAME) !== Boolean(env.TURN_CREDENTIAL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURN_CREDENTIAL"],
        message: "TURN_USERNAME and TURN_CREDENTIAL must be set together",
      });
    }
  });

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  nodeEnv: "development" | "production" | "test";
  port: number;
  /** "*" allows any origin (never in production). */
  corsOrigins: string[] | "*";
  redisUrl?: string;
  trustProxy: boolean;
  maxConnectionsPerIp: number;
  stunUrls: string[];
  turnUrls: string[];
  turnSecret?: string;
  turnUsername?: string;
  turnCredential?: string;
  turnTtlSeconds: number;
  logLevel: LogLevel;
  metricsToken?: string;
  shutdownGraceMs: number;
  /** Unique id of this process, used to own sessions in a shared store. */
  instanceId: string;

  /* Matchmaking timings. Not env vars; tests override them to run in milliseconds. */
  matchAcceptTimeoutMs: number;
  /** Accepts this late after expiresAt are still honored (network latency). */
  matchAcceptGraceMs: number;
  sweepIntervalMs: number;
  /**
   * How often the sweeper runs a FULL match pass (O(waiting^2)); in between it
   * only matches sessions queued since the last pass. The full pass picks up
   * lapsed blocks and users queued on other instances.
   */
  fullMatchPassIntervalMs: number;
  /**
   * Every instance refreshes its heartbeat this often. Sessions of an
   * instance whose heartbeat is older than instanceTtlMs are removed by the
   * other instances (their partners get partner-unavailable).
   */
  heartbeatIntervalMs: number;
  instanceTtlMs: number;
  /** Coins are awarded once per full interval of active call. */
  coinIntervalMs: number;
  coinsPerInterval: number;
  initialCoins: number;
  /** Continuous call time after which the two devices become friends. */
  friendAfterMs: number;
  /** Pair block after a decline or an accept timeout. */
  declineBlockMs: number;
  /** Pair block per skip; multiplied by the pair's skip count. */
  skipBlockMs: number;
  /** Pair block after a report. */
  reportBlockMs: number;
  /** A report is accepted this long after its room ended. */
  reportAfterEndMs: number;

  /* Enforcement (src/enforcement). */
  /** Bearer token for /admin/api. Unset: the admin API answers 503 (never open). */
  adminToken?: string;
  /** Exact client IPs allowed to use the admin API; empty allows any. */
  adminAllowedIps: string[];
  /** Local evidence directory, used when no S3 bucket is set. */
  evidenceDir: string;
  evidenceS3Bucket?: string;
  evidenceS3Region?: string;
  evidenceS3KmsKeyId?: string;
  /** Salt for the pseudonymous device ids admins see. Defaults to one derived from ADMIN_TOKEN. */
  pseudonymSalt?: string;
  turnstileSecretKey?: string;
}

export class ConfigError extends Error {}

/** Parses the environment. Throws ConfigError listing every problem. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings as unset so `FOO=` in an env file means "use the default".
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== "") cleaned[key] = value.trim();
  }
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "env"}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const origins = csv(e.CORS_ORIGINS);
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    corsOrigins: origins.length === 0 || origins.includes("*") ? "*" : origins,
    redisUrl: e.REDIS_URL,
    trustProxy: e.TRUST_PROXY,
    maxConnectionsPerIp: e.MAX_CONNECTIONS_PER_IP,
    stunUrls: csv(e.STUN_URLS),
    turnUrls: csv(e.TURN_URLS),
    turnSecret: e.TURN_SECRET,
    turnUsername: e.TURN_USERNAME,
    turnCredential: e.TURN_CREDENTIAL,
    turnTtlSeconds: e.TURN_TTL_SECONDS,
    logLevel: e.LOG_LEVEL,
    metricsToken: e.METRICS_TOKEN,
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    instanceId: randomUUID(),
    matchAcceptTimeoutMs: e.MATCH_ACCEPT_TIMEOUT_MS,
    matchAcceptGraceMs: 750,
    sweepIntervalMs: 500,
    fullMatchPassIntervalMs: 5_000,
    heartbeatIntervalMs: 5_000,
    instanceTtlMs: 15_000,
    coinIntervalMs: 60_000,
    coinsPerInterval: 5,
    initialCoins: 100,
    friendAfterMs: 5 * 60_000,
    declineBlockMs: 30_000,
    skipBlockMs: 5 * 60_000,
    reportBlockMs: 24 * 60 * 60_000,
    reportAfterEndMs: 60_000,
    adminToken: e.ADMIN_TOKEN,
    adminAllowedIps: csv(e.ADMIN_ALLOWED_IPS),
    evidenceDir: e.EVIDENCE_DIR,
    evidenceS3Bucket: e.EVIDENCE_S3_BUCKET,
    evidenceS3Region: e.EVIDENCE_S3_REGION,
    evidenceS3KmsKeyId: e.EVIDENCE_S3_KMS_KEY_ID,
    pseudonymSalt: e.PSEUDONYM_SALT,
    turnstileSecretKey: e.TURNSTILE_SECRET_KEY,
  };
}
