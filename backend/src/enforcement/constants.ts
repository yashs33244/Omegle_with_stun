/**
 * Named values for the enforcement module. Rule parameters (used by policy.ts)
 * come first, then storage layout and limits (EnforcementService.ts) and the
 * evidence and Turnstile settings. Env-driven values stay in config.ts
 * (reportAfterEndMs, evidenceDir, evidenceS3*, pseudonymSalt, turnstileSecret).
 */
import { RESTRICTION_DURATIONS_MS, type TakedownRequest } from "../protocol";

/* ------------------------------------------------------------------ */
/* Time units (ms)                                                     */
/* ------------------------------------------------------------------ */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const YEAR = 365 * DAY;

/* ------------------------------------------------------------------ */
/* Rules (policy.ts)                                                   */
/* ------------------------------------------------------------------ */

/** Sentinel ladder step: a warning record with no blocking effect. */
export const WARNING_STEP = "warning";
/** One rung of the ladder: a duration in ms, null for permanent, or a warning. */
export type LadderStep = number | null | typeof WARNING_STEP;

/** The only automatic, report-driven action: a short pause (ms). */
export const AUTO_PAUSE_MS = 10 * MINUTE;

/** Human ladder: warning, then the protocol's timed rungs (10 min, 24 h, 7 days), then permanent (null). */
export const LADDER: readonly LadderStep[] = [WARNING_STEP, ...RESTRICTION_DURATIONS_MS, null];

/** Reports per device per hour; the next one is refused. */
export const REPORTS_PER_HOUR = 5;
/**
 * Reports per client IP per hour, across devices. Many Indian mobile users share
 * one CGNAT address, so this is a wide net against one attacker spawning fresh
 * devices on one connection, not a per-person cap (that is REPORTS_PER_HOUR).
 */
export const REPORTS_PER_IP_PER_HOUR = 30;
/** Weighted reports against a device within this window (ms) count toward an auto pause. */
export const AUTO_PAUSE_WINDOW_MS = DAY;
/** Sum of reporter weights that triggers an auto pause. Fresh devices weigh about 0.23, so it takes 8 of them. */
export const AUTO_PAUSE_THRESHOLD = 1.6;
/** A reporter at or above this weight (0..1) corroborates an underage report alone. */
export const HIGH_WEIGHT = 0.7;
/** Calls shorter than this (ms) carry half weight. */
export const SHORT_CALL_MS = 2_000;
/** A call at least this long (ms) counts as completed for the reporter weight. */
export const COMPLETED_CALL_MS = 30_000;
/** A second underage report within this window (ms) corroborates the first. */
export const UNDERAGE_CORROBORATION_WINDOW_MS = 7 * DAY;

/** Classifier score (0..1) at or above which a frame counts as NSFW for CSAM routing. */
export const NSFW_THRESHOLD = 0.7;
/** Classifier score (0..1) at or above which a frame counts as showing a minor. */
export const MINOR_THRESHOLD = 0.5;

/** Reports must be acknowledged within this time (ms) of creation. */
export const ACK_SLA_MS = DAY;
/** Resolution target (ms) for nudity, minors and restricted items. */
export const URGENT_RESOLVE_SLA_MS = 3 * DAY;
/** Resolution target (ms) for everything else. */
export const RESOLVE_SLA_MS = 15 * DAY;
/** Takedown clocks (ms): 24 h for CSAM, 48 h for NCII (TAKE IT DOWN Act), 15 days otherwise. */
export const TAKEDOWN_SLA_MS: Record<TakedownRequest["kind"], number> = {
  csam: DAY,
  ncii: 2 * DAY,
  impersonation: 15 * DAY,
  other: 15 * DAY,
};
/** Appeals have a 48 h target (ms). */
export const APPEAL_DUE_MS = 2 * DAY;

/**
 * Reporter weight = BASE + AGE * age + CALLS * calls + UPHELD * upheldShare,
 * each input saturating at 1. The four terms sum to 1, so the weight stays in [0, 1].
 */
export const REPORTER_WEIGHT = {
  base: 0.05,
  age: 0.3,
  calls: 0.3,
  upheld: 0.35,
} as const;
/** Device age (hours) at which the age term saturates. */
export const FULL_WEIGHT_AGE_HOURS = 72;
/** Completed calls at which the calls term saturates. */
export const FULL_WEIGHT_CALLS = 10;
/** Upheld share assumed for a reporter with no decided reports yet. */
export const NEUTRAL_UPHELD_SHARE = 0.5;
/** A reporter with this many dismissed reports and an upheld share below the floor weighs 0. */
export const DISMISSED_FOR_ZERO_WEIGHT = 3;
export const UPHELD_SHARE_FLOOR = 0.25;
/** Weights are rounded to this many decimals so stored values stay short. */
export const WEIGHT_DECIMALS = 3;

/* ------------------------------------------------------------------ */
/* Storage layout and limits (EnforcementService.ts)                   */
/* ------------------------------------------------------------------ */

/** Device stats (first seen, completed calls, upheld/dismissed counts) live this long (ms) after the last write. */
export const DEVICE_TTL_MS = YEAR;
/** The device -> fingerprint link lives this long (ms) so later restrictions cover both. */
export const FINGERPRINT_TTL_MS = 180 * DAY;
/** Network facts (IP, country) for CSAM packets are kept this long (ms). */
export const NETWORK_TTL_MS = DAY;
/** A finished room stays reportable for reportAfterEndMs plus this grace (ms) for clock skew. */
export const LAST_ROOM_GRACE_MS = 5_000;
/** Default for EnforcementDeps.reportAfterEndMs (ms) when the caller passes none. */
export const DEFAULT_REPORT_AFTER_END_MS = MINUTE;
/** Collection score for a permanent restriction: never reached by the retention cutoff. */
export const PERMANENT_SCORE = Number.MAX_SAFE_INTEGER;

/** Appeals accepted per IP per hour; the next one is rate limited. */
export const APPEALS_PER_IP_PER_HOUR = 10;
/** Appeals accepted per device per day. */
export const APPEALS_PER_DEVICE_PER_DAY = 5;
/** The one-appeal-per-restriction claim lives this long (ms): longer than any record. */
export const APPEAL_CLAIM_TTL_MS = 2 * YEAR;
/** Takedown tickets accepted per IP per hour. */
export const TAKEDOWNS_PER_IP_PER_HOUR = 5;

/** Most recent records returned by the admin list endpoints. */
export const ADMIN_LIST_LIMIT = 500;

/** Records (and evidence) are deleted this long (ms) after they stopped mattering. */
export const RETENTION_MS = YEAR;
/** Escalated (CSAM) evidence is frozen for at least this long (ms). */
export const CSAM_PRESERVE_MS = YEAR;
/** The retention sweeper checks for a daily claim this often (ms). */
export const RETENTION_CHECK_INTERVAL_MS = HOUR;
/** Hex characters of the salted device pseudonym shown to admins (64 bits). */
export const PSEUDONYM_HEX_CHARS = 16;

/** Document collections of the enforcement store (type: EnforcementStore.ts). */
export const COLLECTIONS = ["report", "restriction", "appeal", "takedown", "audit"] as const;

/** Default Redis key prefix of the enforcement store. */
export const ENFORCEMENT_KEY_PREFIX = "chizzy:enf:";

/** Secondary indexes with a fixed name. */
export const INDEX = {
  /** Open and acknowledged reports, scored by creation time. */
  openReports: "open-reports",
  /** Pending appeals, scored by due time. */
  pendingAppeals: "pending-appeals",
} as const;

/** Per-device numeric fields in the `dev:` record (see DeviceStats). */
export const DEVICE_FIELD = {
  firstSeen: "firstSeen",
  completedCalls: "completedCalls",
  upheld: "upheld",
  dismissed: "dismissed",
  minorFlag: "minorFlag",
} as const;

/** Key builders for values, counters, claims and per-device indexes. */
export const KEY = {
  device: (deviceId: string) => `dev:${deviceId}`,
  network: (deviceId: string) => `net:${deviceId}`,
  lastRoom: (roomId: string) => `lastroom:${roomId}`,
  fingerprint: (deviceId: string) => `fp:${deviceId}`,
  /** `network` is the salted hash of the client's address bucket (EnforcementService.network), never the address. */
  reportIpRate: (network: string) => `report-ip:${network}`,
  lastAutoPause: (deviceId: string) => `lastauto:${deviceId}`,
  reportRate: (deviceId: string) => `report-rate:${deviceId}`,
  roomReport: (roomId: string, reporterDevice: string) => `room-report:${roomId}:${reporterDevice}`,
  appealIpRate: (network: string) => `appeal-ip:${network}`,
  appealDeviceRate: (deviceId: string) => `appeal-dev:${deviceId}`,
  appealClaim: (restrictionId: string) => `appeal:${restrictionId}`,
  takedownIpRate: (network: string) => `takedown-ip:${network}`,
  retentionClaim: (day: number) => `retention:${day}`,
  /** Reports against a device, scored by creation time. */
  reportsAgainst: (deviceId: string) => `against:${deviceId}`,
  /** Restrictions of a device, scored by creation time. */
  restrictions: (deviceId: string) => `restrictions:${deviceId}`,
  /** Restrictions recorded against a fingerprint. */
  restrictionsByFingerprint: (fingerprintHash: string) => `restrictions-fp:${fingerprintHash}`,
} as const;

/** Audit log actions. `report.<action>` and `appeal.<decision>` are built from the admin request. */
export const AUDIT_ACTION = {
  autoPause: "auto.pause",
  evidenceDenied: "report.evidence_denied",
  viewEvidence: "report.view_evidence",
  escalateCsam: "report.escalate_csam",
  resolveTakedown: "takedown.resolve",
} as const;

/** Results of admitReport. */
export const ADMIT_RESULTS = ["ok", "rate_limited", "duplicate"] as const;

/** Failure codes of the admin operations (mapped to HTTP statuses in http/admin.ts). */
export const ADMIN_ERRORS = ["not_found", "conflict", "restricted"] as const;

/* ------------------------------------------------------------------ */
/* Evidence (evidence.ts)                                              */
/* ------------------------------------------------------------------ */

/** Decoded size cap (bytes). The protocol caps the data URL at 120k chars, about 90 KB of JPEG. */
export const EVIDENCE_MAX_BYTES = 96 * 1024;
/** Fewer bytes than this cannot be a JPEG (magic bytes plus one marker). */
export const EVIDENCE_MIN_BYTES = 4;
export const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";
/** JPEG files start with SOI (FF D8) followed by a marker (FF). */
export const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
/** Evidence ids are server-generated UUIDs; anything else is refused so a path can never escape the directory. */
export const EVIDENCE_ID_PATTERN = /^[a-f0-9-]{36}$/;
/** Storage area per evidence location: restricted (suspected CSAM) items live apart from general ones. */
export const EVIDENCE_AREA = { general: "general", restricted: "restricted" } as const;
/** Evidence directories are private to the server user. */
export const EVIDENCE_DIR_MODE = 0o700;
export const EVIDENCE_FILE_MODE = 0o600;
export const EVIDENCE_EXTENSION = ".jpg";
