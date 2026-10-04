/**
 * Configuration owned by the matching lane: TURN provider and credential
 * rules, the TURN spend poller, the relaxation ladder and the safety signals.
 * config.ts merges the env shape, the refinement and the parsed values.
 */
import { z } from "zod";

export const TURN_PROVIDERS = ["none", "static", "secret", "cloudflare"] as const;
export type TurnProviderName = (typeof TURN_PROVIDERS)[number];

const int = (min: number) => z.coerce.number().int().min(min);

/** Env variables (merged into the envSchema object in config.ts). */
export const MATCH_ENV = {
  /** Unset: "secret" with TURN_SECRET, "static" with TURN_USERNAME, else "none". */
  TURN_PROVIDER: z.enum(TURN_PROVIDERS).optional(),
  CF_TURN_KEY_ID: z.string().min(1).optional(),
  CF_TURN_API_TOKEN: z.string().min(1).optional(),
  /** Per-device credential cache, so a burst of Next presses reuses one credential set. */
  TURN_CACHE_SECONDS: int(0).default(300),
  TURN_MAX_PER_DEVICE_HOUR: int(1).default(20),
  TURN_MAX_PER_IP_HOUR: int(1).default(100),
  CF_ACCOUNT_ID: z.string().min(1).optional(),
  CF_ANALYTICS_TOKEN: z.string().min(1).optional(),
  /** Three ascending daily TURN egress thresholds in GB: lower relay bitrate, disable Hide my IP, disable TURN. */
  TURN_SPEND_DAILY_GB: z.string().default("35,50,70"),
} as const;

type MatchEnv = z.infer<z.ZodObject<typeof MATCH_ENV>> & {
  TURN_SECRET?: string;
  TURN_USERNAME?: string;
};

function parseThresholds(value: string): [number, number, number] | null {
  const parts = value.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  const [a, b, c] = parts as [number, number, number];
  return a <= b && b <= c ? [a, b, c] : null;
}

export function refineMatchEnv(env: MatchEnv, ctx: z.RefinementCtx): void {
  const provider = resolveProvider(env);
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (provider === "cloudflare" && (!env.CF_TURN_KEY_ID || !env.CF_TURN_API_TOKEN)) {
    issue("CF_TURN_KEY_ID", "CF_TURN_KEY_ID and CF_TURN_API_TOKEN are required when TURN_PROVIDER=cloudflare");
  }
  if (provider === "secret" && !env.TURN_SECRET) issue("TURN_SECRET", "is required when TURN_PROVIDER=secret");
  if (provider === "static" && !env.TURN_USERNAME) issue("TURN_USERNAME", "is required when TURN_PROVIDER=static");
  if (Boolean(env.CF_ACCOUNT_ID) !== Boolean(env.CF_ANALYTICS_TOKEN)) {
    issue("CF_ANALYTICS_TOKEN", "CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN must be set together");
  }
  if (!parseThresholds(env.TURN_SPEND_DAILY_GB)) {
    issue("TURN_SPEND_DAILY_GB", "must be three ascending positive numbers, e.g. 35,50,70");
  }
}

function resolveProvider(env: MatchEnv): TurnProviderName {
  if (env.TURN_PROVIDER) return env.TURN_PROVIDER;
  if (env.TURN_SECRET) return "secret";
  if (env.TURN_USERNAME) return "static";
  return "none";
}

export interface MatchConfig {
  turnProvider: TurnProviderName;
  cfTurnKeyId?: string;
  cfTurnApiToken?: string;
  turnCacheSeconds: number;
  turnMaxPerDeviceHour: number;
  turnMaxPerIpHour: number;
  /** Cloudflare analytics for the TURN spend poller; the poller runs only when both are set. */
  cfAccountId?: string;
  cfAnalyticsToken?: string;
  turnSpendDailyGb: [number, number, number];
  turnSpendPollMs: number;

  /* Not env vars; tests shrink them. */
  /** Relaxation ladder: topics stop being required after this wait. */
  relaxTopicsAfterMs: number;
  /** The soft same-language preference stops after this wait. */
  relaxLanguageAfterMs: number;
  /** Extra wait before a low-priority device (risk score or early skips) can be matched. */
  lowPriorityDelayMs: number;
  /** Links, handles and phone numbers in chat are hidden this long after a call starts. */
  chatGuardMs: number;
  /** A partner who skips within this time of call start counts as an early skip. */
  earlySkipMs: number;
  /** Early-skip share above which a device gets low priority, once it has enough calls. */
  earlySkipShare: number;
  earlySkipMinCalls: number;
  /** Soft risk points (24 h window) at which a device gets low priority. Never a ban. */
  riskThreshold: number;
  /** How long low priority lasts after the last trigger. */
  lowPriorityMs: number;
}

export function matchConfigFromEnv(env: MatchEnv): MatchConfig {
  return {
    turnProvider: resolveProvider(env),
    cfTurnKeyId: env.CF_TURN_KEY_ID,
    cfTurnApiToken: env.CF_TURN_API_TOKEN,
    turnCacheSeconds: env.TURN_CACHE_SECONDS,
    turnMaxPerDeviceHour: env.TURN_MAX_PER_DEVICE_HOUR,
    turnMaxPerIpHour: env.TURN_MAX_PER_IP_HOUR,
    cfAccountId: env.CF_ACCOUNT_ID,
    cfAnalyticsToken: env.CF_ANALYTICS_TOKEN,
    turnSpendDailyGb: parseThresholds(env.TURN_SPEND_DAILY_GB) ?? [35, 50, 70],
    turnSpendPollMs: 15 * 60_000,
    relaxTopicsAfterMs: 5_000,
    relaxLanguageAfterMs: 10_000,
    lowPriorityDelayMs: 4_000,
    chatGuardMs: 2 * 60_000,
    earlySkipMs: 3_000,
    earlySkipShare: 0.6,
    earlySkipMinCalls: 10,
    riskThreshold: 6,
    lowPriorityMs: 60 * 60_000,
  };
}
