/**
 * Environment configuration, parsed once at startup with zod.
 * Invalid configuration fails fast with a readable message (see loadConfig).
 * Every variable is documented in backend/.env.example.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { MATCH_ENV, matchConfigFromEnv, refineMatchEnv, type MatchConfig } from "./match/matchConfig";

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

/** One ADMIN_ALLOWED_IPS entry: an IP literal (prefix null) or a CIDR block. */
export interface IpRange {
  address: string;
  prefix: number | null;
  type: "ipv4" | "ipv6";
}

/** Parses `203.0.113.7`, `203.0.113.0/24`, `2001:db8::1` or `2001:db8::/32`; null for anything else. */
export function parseIpRange(entry: string): IpRange | null {
  const [address = "", prefix, ...rest] = entry.split("/");
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return null;
  const type = version === 4 ? "ipv4" : "ipv6";
  if (prefix === undefined) return { address, prefix: null, type };
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)) return null;
  return { address, prefix: Number(prefix), type };
}

/**
 * Headers that carry a client-controlled list (every hop appends), so the
 * first element is whatever the client sent. The proxy IP header must be one
 * the last trusted hop overwrites with a single address.
 */
const LIST_IP_HEADERS: Record<string, true> = { "x-forwarded-for": true, forwarded: true, via: true };
/**
 * A secret made of a handful of repeated characters is a placeholder, not a
 * secret. `openssl rand -hex 32` has 16 possible characters; 64 draws from
 * them reach this floor with overwhelming probability.
 */
const MIN_DISTINCT_SECRET_CHARS = 8;
/**
 * ADMIN_TOKEN length floor in production (characters): the admin API is open
 * to the internet on Render, guarded by this token and the failure limits in
 * http/constants.ts. 24 stays the floor elsewhere.
 */
const MIN_PRODUCTION_ADMIN_TOKEN_CHARS = 32;

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: int(0).max(65535).default(3004),
    CORS_ORIGINS: z.string().optional(),
    REDIS_URL: z.string().url().optional(),
    TRUST_PROXY: bool.default("false"),
    PROXY_IP_HEADER: z.string().min(1).default("x-real-ip"),
    KEEPALIVE_URL: z.string().url().optional(),
    RENDER_EXTERNAL_URL: z.string().url().optional(),
    MAX_CONNECTIONS_PER_IP: int(1).default(10),
    CONNECT_BURST_PER_IP: int(1).default(20),
    CONNECT_RATE_PER_IP_PER_SEC: int(1).default(1),
    MATCH_ACCEPT_TIMEOUT_MS: int(1000).default(30000),
    STUN_URLS: z.string().default("stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"),
    TURN_URLS: z.string().optional(),
    TURN_SECRET: z.string().min(1).optional(),
    TURN_USERNAME: z.string().min(1).optional(),
    TURN_CREDENTIAL: z.string().min(1).optional(),
    TURN_TTL_SECONDS: int(60).default(7200),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    METRICS_TOKEN: z.string().min(1).optional(),
    SHUTDOWN_GRACE_MS: int(0).default(10000),
    SESSION_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
    SESSION_SECRET_PREVIOUS: z.string().min(32, "must be at least 32 characters").optional(),
    TURNSTILE_SECRET: z.string().min(1).optional(),
    TURNSTILE_SITE_KEY: z.string().min(1).optional(),
    TURNSTILE_DISABLED: bool.default("false"),
    TRUST_CLOUDFLARE: bool.default("false"),
    SESSION_RATE_PER_IP_PER_MIN: int(1).default(10),
    SESSION_RATE_PER_NETWORK_PER_MIN: int(1).default(60),
    SESSION_NEW_DEVICES_PER_NETWORK_PER_DAY: int(1).default(50),
    MATCH_CAP_PER_DEVICE_PER_HOUR: int(1).default(200),
    MATCH_CAP_PER_IP_PER_HOUR: int(1).default(200),
    MATCH_CAP_PER_DEVICE_PER_MIN: int(1).default(20),
    SENTRY_DSN: z.string().url().optional(),
    SENTRY_DSN_FRONTEND: z.string().url().optional(),
    POSTHOG_KEY: z.string().min(1).optional(),
    POSTHOG_HOST: z.string().url().optional(),
    ...MATCH_ENV,
    ADMIN_TOKEN: z.string().min(24, "must be at least 24 characters").optional(),
    ADMIN_ALLOWED_IPS: z.string().optional(),
    EVIDENCE_DIR: z.string().default("./data/evidence"),
    EVIDENCE_S3_BUCKET: z.string().min(3).optional(),
    EVIDENCE_S3_REGION: z.string().min(1).optional(),
    EVIDENCE_S3_KMS_KEY_ID: z.string().min(1).optional(),
    PSEUDONYM_SALT: z.string().min(16).optional(),
    RAZORPAY_KEY_ID: z.string().min(1).optional(),
    RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
    RAZORPAY_FAKE: bool.default("false"),
  })
  .superRefine((env, ctx) => {
    refineMatchEnv(env, ctx);
    const origins = csv(env.CORS_ORIGINS);
    if (env.NODE_ENV === "production" && !env.ADMIN_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ADMIN_TOKEN"],
        message: "is required in production (the admin API stays closed without it)",
      });
    } else if (env.NODE_ENV === "production" && env.ADMIN_TOKEN && env.ADMIN_TOKEN.length < MIN_PRODUCTION_ADMIN_TOKEN_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ADMIN_TOKEN"],
        message: `must be at least ${MIN_PRODUCTION_ADMIN_TOKEN_CHARS} characters in production (openssl rand -hex 32)`,
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
    for (const entry of csv(env.ADMIN_ALLOWED_IPS)) {
      if (!parseIpRange(entry)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ADMIN_ALLOWED_IPS"],
          message: `invalid entry "${entry}" (expected an IP address or a CIDR block such as 203.0.113.0/24, comma separated)`,
        });
      }
    }
    // Browsers throw from new RTCPeerConnection() on a bad ICE server URL, so
    // one typo here would break every call; refuse to start instead.
    const iceUrls = [
      ["STUN_URLS", env.STUN_URLS, /^stuns?:\S+$/, "stun: or stuns:"],
      ["TURN_URLS", env.TURN_URLS, /^turns?:\S+$/, "turn: or turns:"],
    ] as const;
    for (const [key, value, pattern, scheme] of iceUrls) {
      for (const url of csv(value)) {
        if (!pattern.test(url)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `invalid URL "${url}" (expected ${scheme} followed by host[:port], comma separated)`,
          });
        }
      }
    }
    if ((env.TURN_SECRET || env.TURN_USERNAME) && csv(env.TURN_URLS).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURN_URLS"],
        message: "is required when TURN_SECRET or TURN_USERNAME is set",
      });
    }
    // The header is used verbatim as the client IP; a list header keeps the
    // client's own prefix, so TRUST_PROXY would let it pick its rate-limit key.
    if (LIST_IP_HEADERS[env.PROXY_IP_HEADER.toLowerCase()]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PROXY_IP_HEADER"],
        message: `${env.PROXY_IP_HEADER} is a list that clients can prepend to; use a header the proxy sets to one address (x-real-ip, true-client-ip, cf-connecting-ip)`,
      });
    }
    if (env.NODE_ENV === "production") {
      const secrets = [
        ["SESSION_SECRET", env.SESSION_SECRET],
        ["SESSION_SECRET_PREVIOUS", env.SESSION_SECRET_PREVIOUS],
        ["ADMIN_TOKEN", env.ADMIN_TOKEN],
      ] as const;
      for (const [key, value] of secrets) {
        if (value && new Set(value).size < MIN_DISTINCT_SECRET_CHARS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `looks like a placeholder (fewer than ${MIN_DISTINCT_SECRET_CHARS} distinct characters); use openssl rand -hex 32`,
          });
        }
      }
    }
    if (env.NODE_ENV === "production" && !env.SESSION_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SESSION_SECRET"],
        message: "is required in production (at least 32 random characters, e.g. openssl rand -hex 32)",
      });
    }
    if (env.NODE_ENV === "production" && !env.TURNSTILE_SECRET && !env.TURNSTILE_DISABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURNSTILE_SECRET"],
        message: "is required in production (set TURNSTILE_DISABLED=true to run without bot protection)",
      });
    }
    if (env.TURNSTILE_SECRET && !env.TURNSTILE_DISABLED && !env.TURNSTILE_SITE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURNSTILE_SITE_KEY"],
        message: "is required when TURNSTILE_SECRET is set (clients need it to render the challenge)",
      });
    }
    if (Boolean(env.TURN_USERNAME) !== Boolean(env.TURN_CREDENTIAL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURN_CREDENTIAL"],
        message: "TURN_USERNAME and TURN_CREDENTIAL must be set together",
      });
    }
    if (Boolean(env.RAZORPAY_KEY_ID) !== Boolean(env.RAZORPAY_KEY_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RAZORPAY_KEY_SECRET"],
        message: "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set together",
      });
    }
    if (env.NODE_ENV === "production" && env.RAZORPAY_KEY_ID && !env.RAZORPAY_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RAZORPAY_WEBHOOK_SECRET"],
        message: "is required in production when RAZORPAY_KEY_ID is set (the webhook is the second crediting path)",
      });
    }
    if (env.RAZORPAY_FAKE && env.NODE_ENV === "production") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RAZORPAY_FAKE"],
        message: "is for tests only and must not be set in production",
      });
    }
  });

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config extends MatchConfig {
  nodeEnv: "development" | "production" | "test";
  port: number;
  /** "*" allows any origin (never in production). */
  corsOrigins: string[] | "*";
  redisUrl?: string;
  /**
   * Request header holding the client IP, or null to use the TCP peer.
   * PROXY_IP_HEADER (default X-Real-IP, which our gateway sets) is trusted
   * only when TRUST_PROXY is on; on Render it is True-Client-IP.
   */
  proxyIpHeader: string | null;
  /**
   * URL this process GETs every 10 minutes to count as inbound traffic for
   * hosts that idle out free instances (Render spins down after 15 minutes
   * without a request). KEEPALIVE_URL, or <RENDER_EXTERNAL_URL>/healthz when
   * Render provides that; unset elsewhere.
   */
  keepaliveUrl?: string;
  maxConnectionsPerIp: number;
  /**
   * New connections per client IP (per instance): a burst, then a steady
   * rate. Per-socket rate limits start full, so without this a client could
   * reconnect to refill them. CONNECT_BURST_PER_IP and
   * CONNECT_RATE_PER_IP_PER_SEC; raise them only for load tests, where every
   * virtual user comes from one address.
   */
  connectRatePerIp: { capacity: number; refillPerSec: number };
  /**
   * A socket that has not sent a well-formed session:hello this long after
   * connecting is disconnected (realtime/socket.ts). Not an env var; the SPA
   * sends hello on connect, tests shrink it.
   */
  helloTimeoutMs: number;
  stunUrls: string[];
  turnUrls: string[];
  turnSecret?: string;
  turnUsername?: string;
  turnCredential?: string;
  turnTtlSeconds: number;
  logLevel: LogLevel;
  metricsToken?: string;
  shutdownGraceMs: number;
  /** Signs session and age tokens. Random per process outside production when unset. */
  sessionSecret: string;
  /** True when sessionSecret was generated at startup (tokens die with the process). */
  sessionSecretGenerated: boolean;
  /** Old secret still accepted for verification during a rotation. */
  sessionSecretPrevious?: string;
  /** Turnstile Siteverify secret; undefined means verification is off. */
  turnstileSecret?: string;
  turnstileSiteKey?: string;
  /** CF-IPCountry is trusted (both hosts are behind Cloudflare and the origin only accepts Cloudflare). */
  trustCloudflare: boolean;
  sessionRatePerIpPerMin: number;
  sessionRatePerNetworkPerMin: number;
  /** Distinct new device ids (date-of-birth sessions) per IPv4 address or IPv6 /64 per UTC day. */
  sessionNewDevicesPerNetworkPerDay: number;
  matchCapPerDevicePerHour: number;
  matchCapPerIpPerHour: number;
  /** Rooms a device may end itself (skip, decline) per minute before its re-queue is refused. */
  matchCapPerDevicePerMin: number;
  sentryDsn?: string;
  sentryDsnFrontend?: string;
  posthogKey?: string;
  posthogHost?: string;
  /**
   * The Socket.IO handshake requires a session token. Always true from the
   * environment; only tests turn it off (via createServer's config).
   */
  requireSession: boolean;
  /** How often matching:status is re-checked for staffed-hours boundaries. */
  matchingStatusIntervalMs: number;
  /** Unique id of this process, used to own sessions in a shared store. */
  instanceId: string;

  /* Matchmaking timings. Not env vars; tests override them to run in milliseconds. */
  matchAcceptTimeoutMs: number;
  /** Accepts this late after expiresAt are still honored (network latency). */
  matchAcceptGraceMs: number;
  sweepIntervalMs: number;
  /**
   * How often the sweeper rechecks a slice of the waiting queue against
   * everyone else. In between it only matches sessions queued or changed
   * since the last pass, plus sessions whose block just lapsed. The recheck
   * is a safety net for marks this instance never saw (blocks changed or
   * sessions queued elsewhere).
   */
  recheckIntervalMs: number;
  /**
   * Pair checks one recheck may spend. The slice is this divided by the
   * queue length (at least one session), so a recheck never scans all pairs
   * of a long queue and never stalls the event loop; a short queue is
   * rechecked whole.
   */
  recheckPairBudget: number;
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
  /**
   * Balance a brand-new device starts with. Device ids are client-chosen, so
   * anything at or above `gender_filter_coins_per_day` hands every fresh
   * device (incognito window) a free unlock; billing warns when that happens.
   */
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
  /** Client IPs and CIDR blocks allowed to use the admin API (validated by parseIpRange); empty allows any. */
  adminAllowedIps: string[];
  /** Local evidence directory, used when no S3 bucket is set. */
  evidenceDir: string;
  evidenceS3Bucket?: string;
  evidenceS3Region?: string;
  evidenceS3KmsKeyId?: string;
  /** Salt for the pseudonymous device ids admins see. Defaults to one derived from ADMIN_TOKEN. */
  pseudonymSalt?: string;

  /* Billing (src/billing). Razorpay keys from Settings > API Keys; unset: /api/billing answers 503 billing_disabled. */
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  /** Secret chosen when creating the webhook in the Razorpay dashboard. Required in production with RAZORPAY_KEY_ID; unset elsewhere: POST /api/billing/webhook answers 503. */
  razorpayWebhookSecret?: string;
  /** Test-only fake gateway (no HTTP, fixed signature). Refused in production. */
  razorpayFake: boolean;
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
    proxyIpHeader: e.TRUST_PROXY ? e.PROXY_IP_HEADER.toLowerCase() : null,
    keepaliveUrl: e.KEEPALIVE_URL ?? (e.RENDER_EXTERNAL_URL ? `${e.RENDER_EXTERNAL_URL.replace(/\/$/, "")}/healthz` : undefined),
    maxConnectionsPerIp: e.MAX_CONNECTIONS_PER_IP,
    connectRatePerIp: { capacity: e.CONNECT_BURST_PER_IP, refillPerSec: e.CONNECT_RATE_PER_IP_PER_SEC },
    helloTimeoutMs: 30_000,
    stunUrls: csv(e.STUN_URLS),
    turnUrls: csv(e.TURN_URLS),
    turnSecret: e.TURN_SECRET,
    turnUsername: e.TURN_USERNAME,
    turnCredential: e.TURN_CREDENTIAL,
    turnTtlSeconds: e.TURN_TTL_SECONDS,
    logLevel: e.LOG_LEVEL,
    metricsToken: e.METRICS_TOKEN,
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    sessionSecret: e.SESSION_SECRET ?? randomBytes(32).toString("hex"),
    sessionSecretGenerated: !e.SESSION_SECRET,
    sessionSecretPrevious: e.SESSION_SECRET_PREVIOUS,
    turnstileSecret: e.TURNSTILE_DISABLED ? undefined : e.TURNSTILE_SECRET,
    turnstileSiteKey: e.TURNSTILE_DISABLED ? undefined : e.TURNSTILE_SITE_KEY,
    trustCloudflare: e.TRUST_CLOUDFLARE,
    sessionRatePerIpPerMin: e.SESSION_RATE_PER_IP_PER_MIN,
    sessionRatePerNetworkPerMin: e.SESSION_RATE_PER_NETWORK_PER_MIN,
    sessionNewDevicesPerNetworkPerDay: e.SESSION_NEW_DEVICES_PER_NETWORK_PER_DAY,
    matchCapPerDevicePerHour: e.MATCH_CAP_PER_DEVICE_PER_HOUR,
    matchCapPerIpPerHour: e.MATCH_CAP_PER_IP_PER_HOUR,
    matchCapPerDevicePerMin: e.MATCH_CAP_PER_DEVICE_PER_MIN,
    sentryDsn: e.SENTRY_DSN,
    sentryDsnFrontend: e.SENTRY_DSN_FRONTEND,
    posthogKey: e.POSTHOG_KEY,
    posthogHost: e.POSTHOG_HOST,
    requireSession: true,
    matchingStatusIntervalMs: 30_000,
    instanceId: randomUUID(),
    matchAcceptTimeoutMs: e.MATCH_ACCEPT_TIMEOUT_MS,
    matchAcceptGraceMs: 750,
    sweepIntervalMs: 500,
    recheckIntervalMs: 5_000,
    recheckPairBudget: 100_000,
    heartbeatIntervalMs: 5_000,
    instanceTtlMs: 15_000,
    coinIntervalMs: 60_000,
    coinsPerInterval: 5,
    initialCoins: 0,
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
    razorpayKeyId: e.RAZORPAY_KEY_ID,
    razorpayKeySecret: e.RAZORPAY_KEY_SECRET,
    razorpayWebhookSecret: e.RAZORPAY_WEBHOOK_SECRET,
    razorpayFake: e.RAZORPAY_FAKE,
    ...matchConfigFromEnv(e),
  };
}
