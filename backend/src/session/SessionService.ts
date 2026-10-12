/**
 * POST /api/session: the gate in front of matching (LB-2, LB-3, LB-10).
 *
 * Order: rate limit, kill switch, region, lockout, Turnstile, age and Terms,
 * restriction (device, then a recent ban on the client's address), the
 * daily new-device cap per address, then tokens. The date of birth is used
 * to compute the age and then dropped: it is never stored, logged or put in
 * a token.
 */
import type { FlagsReader } from "../flags/flags";
import type { Logger } from "../logger";
import {
  TOS_VERSION,
  sessionRequestSchema,
  type Restriction,
  type SessionError,
  type SessionResponse,
} from "../protocol";
import { ageInYears } from "./age";
import { ADULT_AGE, AGE_TOKEN_TTL_MS, SESSION_ERROR_STATUS, SESSION_TOKEN_TTL_MS, TURNSTILE_LOCAL_ERROR, UNKNOWN_IP } from "./constants";
import { isCountryBlocked } from "./geo";
import type { Lockout, NewDeviceCap, SessionRateLimiter } from "./limits";
import type { TokenSigner } from "./tokens";
import { verifyTurnstile, type FetchLike } from "./turnstile";

/**
 * Implemented by the enforcement lane (EnforcementService). `fingerprint` is
 * the client's SHA-256 fingerprint as sent: the lane links it to the device so
 * a restriction follows the browser to a fresh device id.
 */
export interface RestrictionChecker {
  activeForDevice(deviceId: string, fingerprint: string): Promise<Restriction | null>;
  /**
   * A `ban` placed in the last few hours on a device seen at this address
   * (IPv4 address or IPv6 /64), or null. Pauses and warnings never count.
   */
  activeForNetwork(ip: string): Promise<Restriction | null>;
  /** Network facts of a device that just passed the gate (kept briefly for CSAM packets). */
  noteDeviceNetwork(deviceId: string, ip: string | null, country: string | null): Promise<void>;
}

export interface SessionRequestContext {
  ip: string;
  /** Country from the trusted edge header, or null. */
  country: string | null;
}

export interface SessionServiceDeps {
  tokens: TokenSigner;
  flags: FlagsReader;
  lockout: Lockout;
  rateLimiter: SessionRateLimiter;
  newDevices: NewDeviceCap;
  logger: Logger;
  /** Undefined turns Turnstile verification off (dev, tests, TURNSTILE_DISABLED). */
  turnstileSecret?: string;
  fetch: FetchLike;
  restrictions?: RestrictionChecker;
  onResult?: (result: "issued" | SessionError) => void;
  now?: () => number;
}

export interface SessionResult {
  status: number;
  body: SessionResponse;
}

export class SessionService {
  private readonly now: () => number;

  constructor(private readonly deps: SessionServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async create(raw: unknown, ctx: SessionRequestContext): Promise<SessionResult> {
    const { deps } = this;
    const fail = (error: SessionError, restriction?: Restriction): SessionResult => {
      deps.onResult?.(error);
      const status = SESSION_ERROR_STATUS[error];
      return { status, body: restriction ? { ok: false, error, restriction } : { ok: false, error } };
    };

    if (!(await deps.rateLimiter.allow(ctx.ip))) return fail("rate_limited");
    const parsed = sessionRequestSchema.safeParse(raw);
    if (!parsed.success) return fail("invalid");
    const req = parsed.data;

    const flags = deps.flags.current();
    if (!flags.new_sessions_enabled) return fail("closed");
    if (isCountryBlocked(ctx.country, flags)) return fail("region_blocked");
    if (await deps.lockout.isLocked(req.deviceId, req.fingerprint, ctx.ip)) return fail("locked");

    if (deps.turnstileSecret) {
      const result = await verifyTurnstile({
        secret: deps.turnstileSecret,
        token: req.turnstileToken,
        remoteIp: ctx.ip,
        fetch: deps.fetch,
      });
      if (!result.success) {
        deps.logger.info({ errors: result.errors }, "turnstile check failed");
        // Saturated outbound verification is our problem, not the client's: 503, retry later.
        return fail(result.errors.includes(TURNSTILE_LOCAL_ERROR.overloaded) ? "closed" : "turnstile_failed");
      }
    }

    const now = this.now();
    let ageToken: string;
    let ageExpiresAt: number;
    if ("dob" in req.age) {
      const age = ageInYears(req.age.dob, now);
      if (age === null) return fail("invalid");
      if (age < ADULT_AGE) {
        await deps.lockout.lock(req.deviceId, req.fingerprint, ctx.ip);
        deps.logger.info("under-18 date of birth: device locked out");
        return fail("underage");
      }
      if (req.age.tosVersion !== TOS_VERSION) return fail("tos_outdated");
      ageExpiresAt = now + AGE_TOKEN_TTL_MS;
      ageToken = deps.tokens.sign({
        kind: "age",
        deviceId: req.deviceId,
        over18: true,
        tosVersion: TOS_VERSION,
        iat: now,
        exp: ageExpiresAt,
      });
    } else {
      if (req.age.tosVersion !== TOS_VERSION) return fail("tos_outdated");
      const proof = deps.tokens.verifyAge(req.age.ageToken, now);
      if (!proof || proof.deviceId !== req.deviceId) return fail("age_token_invalid");
      ageExpiresAt = proof.exp;
      // Re-sign only to record acceptance of newer Terms; the expiry never slides.
      ageToken =
        proof.tosVersion === TOS_VERSION
          ? req.age.ageToken
          : deps.tokens.sign({ ...proof, tosVersion: TOS_VERSION, iat: now });
    }

    const restriction = await deps.restrictions?.activeForDevice(req.deviceId, req.fingerprint);
    if (restriction) return fail("banned", restriction);
    const ip = ctx.ip === UNKNOWN_IP ? null : ctx.ip;
    if (ip) {
      const networkBan = await deps.restrictions?.activeForNetwork(ip);
      if (networkBan) return fail("banned", networkBan);
      // Only a date of birth mints an age token for a fresh device id (an age
      // token is bound to its device), so only those count as new devices.
      if ("dob" in req.age && !(await deps.newDevices.admit(req.deviceId, ip))) return fail("rate_limited");
    }
    await deps.restrictions?.noteDeviceNetwork(req.deviceId, ip, ctx.country);

    const sessionExpiresAt = now + SESSION_TOKEN_TTL_MS;
    const sessionToken = deps.tokens.sign({
      kind: "session",
      deviceId: req.deviceId,
      country: ctx.country,
      iat: now,
      exp: sessionExpiresAt,
    });
    deps.onResult?.("issued");
    return {
      status: 200,
      body: { ok: true, sessionToken, sessionExpiresAt, ageToken, ageExpiresAt, country: ctx.country },
    };
  }
}
