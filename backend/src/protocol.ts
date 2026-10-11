/**
 * Socket.IO protocol shared by the backend and the frontend.
 *
 * Source of truth: backend/src/protocol.ts.
 * The frontend keeps a byte-for-byte copy at new-frontend/src/lib/protocol.ts;
 * run `scripts/sync-protocol.sh` after editing, CI fails if the copies differ.
 *
 * Every client -> server payload is validated with the zod schemas below.
 * The server never trusts a field it can derive itself (socket id, room
 * membership, timestamps, coins).
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 3;

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const TOPICS = [
  "general",
  "gaming",
  "music",
  "movies",
  "sports",
  "technology",
  "art",
  "travel",
  "food",
  "books",
] as const;

export const GENDERS = ["male", "female", "other", "unspecified"] as const;
export const GENDER_FILTERS = ["all", "male", "female", "other"] as const;

/** instant: the server accepts on your behalf and the call starts blurred. preview: you see the partner card and press Accept. */
export const MATCH_MODES = ["instant", "preview"] as const;

export const REPORT_REASONS = [
  "inappropriate",
  "spam",
  "nudity",
  "harassment",
  "hate",
  "violence",
  "fake",
  "underage",
  "other",
] as const;

export const LIMITS = {
  nameMax: 32,
  topicsMax: 10,
  /** Max length of the profile photo data URL, in characters (~110 KB of JPEG). */
  photoMaxChars: 150_000,
  chatMax: 500,
  reportDetailsMax: 500,
  sdpMax: 20_000,
  candidateMax: 2_000,
  /** Evidence frame: a 256 px JPEG data URL captured from the partner's video. */
  evidenceFrameMaxChars: 120_000,
  evidenceChatLinesMax: 20,
  appealMax: 1_000,
  takedownDescriptionMax: 2_000,
} as const;

/* ------------------------------------------------------------------ */
/* Shared value schemas                                                */
/* ------------------------------------------------------------------ */

const languageCode = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/);
const countryCode = z.string().regex(/^[A-Z]{2}$/);
const roomId = z.string().uuid();

/** Only inline images. Remote URLs would leak the partner's IP to a third party. */
const photoDataUrl = z
  .string()
  .max(LIMITS.photoMaxChars)
  .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/);

export const profileSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax),
  country: countryCode,
  language: languageCode,
  gender: z.enum(GENDERS),
  topics: z.array(z.enum(TOPICS)).min(1).max(LIMITS.topicsMax),
  photo: photoDataUrl.optional(),
});

export const preferencesSchema = z.object({
  genderFilter: z.enum(GENDER_FILTERS),
  /** "any" or a language code the partner must speak. */
  languageFilter: z.union([z.literal("any"), languageCode]),
});

export type Topic = (typeof TOPICS)[number];
export type MatchMode = (typeof MATCH_MODES)[number];
export type Gender = (typeof GENDERS)[number];
export type GenderFilter = (typeof GENDER_FILTERS)[number];
export type ReportReason = (typeof REPORT_REASONS)[number];
export type Profile = z.infer<typeof profileSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;

/** What a partner is allowed to see. Gender is used for matching only, never shown. */
export type PublicProfile = Omit<Profile, "gender">;

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/* ------------------------------------------------------------------ */
/* Client -> server payloads                                           */
/* ------------------------------------------------------------------ */

export const helloSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  /** Anonymous, browser-generated id kept in localStorage (crypto.randomUUID()). */
  deviceId: z.string().uuid(),
  profile: profileSchema,
  preferences: preferencesSchema,
  mode: z.enum(MATCH_MODES),
});

export const updatePreferencesSchema = z.object({ preferences: preferencesSchema });

export const roomRefSchema = z.object({ roomId });

/**
 * call:skip may name the room it means. When it does, the server ignores a skip
 * for a room the sender has already left, so a late or repeated skip cannot end
 * the next match. Optional so older clients that send nothing keep working.
 */
export const callSkipSchema = roomRefSchema.optional();

const sessionDescription = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().max(LIMITS.sdpMax),
});

const iceCandidate = z.object({
  candidate: z.string().max(LIMITS.candidateMax),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});

/** Exactly one of description / candidate. */
export const rtcSignalSchema = z
  .object({
    roomId,
    description: sessionDescription.optional(),
    candidate: iceCandidate.optional(),
  })
  .refine((s) => (s.description ? 1 : 0) + (s.candidate ? 1 : 0) === 1, {
    message: "exactly one of description or candidate is required",
  });

export const chatSendSchema = z.object({
  roomId,
  text: z.string().trim().min(1).max(LIMITS.chatMax),
});

export const chatTypingSchema = z.object({ roomId, typing: z.boolean() });

const jpegDataUrl = z
  .string()
  .max(LIMITS.evidenceFrameMaxChars)
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/);

/**
 * Allowed while the room is active or within 60 s after it ended, once per room per reporter.
 * Evidence is captured by the reporter's client, so the server treats it as unverified:
 * it never triggers an automatic penalty on its own.
 */
export const reportSchema = z.object({
  roomId,
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(LIMITS.reportDetailsMax).optional(),
  evidence: z
    .object({
      frame: jpegDataUrl.optional(),
      chat: z
        .array(
          z.object({
            from: z.enum(["me", "partner"]),
            text: z.string().max(LIMITS.chatMax),
            ts: z.number().int().nonnegative(),
          }),
        )
        .max(LIMITS.evidenceChatLinesMax)
        .optional(),
    })
    .optional(),
});

/** The WebRTC connection could not be established (10 s connect timeout or ICE failure). */
export const callFailedSchema = z.object({ roomId, reason: z.enum(["ice-failed", "timeout"]) });

const candidateType = z.enum(["host", "srflx", "prflx", "relay", "unknown"]);

/** Sent once per call when it ends, by each side. No IPs, no content. */
export const callTelemetrySchema = z.object({
  roomId,
  outcome: z.enum(["connected", "ice-failed", "timeout", "ended-before-connect"]),
  timeToConnectMs: z.number().int().min(0).max(600_000).optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
  localCandidateType: candidateType.optional(),
  remoteCandidateType: candidateType.optional(),
  privateMode: z.boolean(),
  rttMs: z.number().min(0).max(60_000).optional(),
  packetLossPct: z.number().min(0).max(100).optional(),
  freezeCount: z.number().int().min(0).max(100_000).optional(),
});

/** Counts from on-device moderation. Never frames, never content. */
export const moderationSignalSchema = z.object({
  roomId,
  kind: z.enum(["nsfw-blur", "no-face", "virtual-camera", "model-unavailable"]),
});

export type HelloPayload = z.infer<typeof helloSchema>;
export type UpdatePreferencesPayload = z.infer<typeof updatePreferencesSchema>;
export type RoomRef = z.infer<typeof roomRefSchema>;
export type RtcSignal = z.infer<typeof rtcSignalSchema>;
export type ChatSendPayload = z.infer<typeof chatSendSchema>;
export type ChatTypingPayload = z.infer<typeof chatTypingSchema>;
export type ReportPayload = z.infer<typeof reportSchema>;
export type CallFailedPayload = z.infer<typeof callFailedSchema>;
export type CallTelemetryPayload = z.infer<typeof callTelemetrySchema>;
export type ModerationSignalPayload = z.infer<typeof moderationSignalSchema>;

/* ------------------------------------------------------------------ */
/* Acks                                                                */
/* ------------------------------------------------------------------ */

export type ErrorCode =
  | "invalid_payload"
  | "rate_limited"
  | "not_in_room"
  | "bad_state"
  | "unsupported_version"
  | "banned" // an active restriction blocks matching; the ack carries `restriction`
  | "matching_closed" // kill switch or outside staffed hours
  | "session_required" // missing, invalid or expired session token (handshake)
  | "region_blocked"
  | "internal";

/* ------------------------------------------------------------------ */
/* Enforcement                                                         */
/* ------------------------------------------------------------------ */

/** Why a restriction was applied. Shown to the restricted user. */
export const RESTRICTION_REASONS = [
  "nudity",
  "minor-safety",
  "harassment",
  "hate",
  "violence",
  "spam",
  "fake-video",
  "underage",
  "other",
] as const;
export type RestrictionReason = (typeof RESTRICTION_REASONS)[number];

export interface Restriction {
  id: string;
  reason: RestrictionReason;
  kind: "warning" | "pause" | "ban";
  /** Epoch ms when it ends; null means permanent. */
  until: number | null;
  createdAt: number;
  /** False for categories where showing evidence back is unsafe (minor safety). */
  evidenceAvailable: boolean;
  appeal: { status: "none" | "pending" | "upheld" | "overturned"; submittedAt?: number; decidedAt?: number };
  appealable: boolean;
}

export type Ack<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: ErrorCode; message?: string; restriction?: Restriction };

export type HelloAck = Ack<{
  coins: number;
  /** STUN only. TURN credentials arrive per call in call:start. */
  iceServers: IceServer[];
  /** The mode the server will use (a flag can force preview). */
  mode: MatchMode;
}>;
export type ChatAck = Ack<{ id: string; ts: number; redacted: boolean }>;
export type ReportAck = Ack<{ reportId: string }>;
export type SimpleAck = Ack;

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export type MatchEndReason =
  | "declined" // you pressed Pass
  | "partner-declined"
  | "timeout" // the partner never accepted within the accept window; you are searching again
  | "accept-timeout" // you never accepted within the accept window; you are idle, not re-queued
  | "skipped" // you skipped
  | "partner-skipped"
  | "partner-left" // partner disconnected or closed the tab
  | "reported" // you reported the partner (call ends, pair is blocked)
  | "partner-unavailable" // server-side cleanup (instance died, session replaced)
  | "connection-failed" // WebRTC could not connect; both are re-queued
  | "restricted"; // a restriction was applied to you mid-call

/**
 * Lifecycle (server-authoritative):
 *   POST /api/session -> socket connects with auth { sessionToken } (rejected with connect_error
 *   data.code "session_required" | "region_blocked" otherwise)
 *   -> session:hello -> queue:waiting -> match:found
 *   -> preview mode: both match:accept; instant mode: the server accepts for that side
 *   -> call:start (per-call ICE servers) -> rtc:signal relay -> ... -> match:ended
 *   -> queue:waiting (auto re-queue)
 * Disconnecting the socket (Home button, tab close) ends any room and notifies the partner.
 * After match:ended the server re-queues the user automatically, except after a restriction.
 */
export interface ServerToClientEvents {
  "queue:waiting": (p: {
    /** 0 = topic + language, 1 = language, 2 = anyone passing the hard filters. */
    relaxStep: number;
    /** Real count of people online, present only above the configured threshold. */
    online?: number;
  }) => void;
  "match:found": (p: {
    roomId: string;
    partner: PublicProfile;
    /** The two devices became friends in an earlier call. */
    isFriend: boolean;
    /** Epoch ms after which the server ends the match if both have not accepted (accepters are re-queued; the rest go idle). */
    expiresAt: number;
    /** Server clock at emit time, so clients can correct clock skew. */
    serverNow: number;
    /** Topics both of you picked. */
    sharedTopics: Topic[];
    /** Your effective mode for this match. In instant mode the server accepts for you. */
    mode: MatchMode;
  }) => void;
  "match:partner-accepted": (p: { roomId: string }) => void;
  "match:ended": (p: { roomId: string; reason: MatchEndReason }) => void;
  /** Both accepted. The initiator creates the offer; the other side answers. */
  "call:start": (p: {
    roomId: string;
    initiator: boolean;
    /** STUN plus per-call TURN credentials (short TTL). */
    iceServers: IceServer[];
    /** Video bitrate caps the client should apply (kbps). */
    maxBitrateKbps: number;
    relayMaxBitrateKbps: number;
    /** Hide my IP is allowed right now (flag + spend cap). */
    privateModeAllowed: boolean;
  }) => void;
  "rtc:signal": (p: RtcSignal) => void;
  /** redacted: links, handles or phone numbers were hidden by the safety guard. */
  "chat:message": (p: { roomId: string; id: string; text: string; ts: number; redacted: boolean }) => void;
  "chat:typing": (p: { roomId: string; typing: boolean }) => void;
  "coins:update": (p: { balance: number; delta: number }) => void;
  /** Sent to both sides after 5 minutes of continuous call. */
  "friends:new": (p: { roomId: string }) => void;
  /** The same deviceId connected from another tab; this socket is about to be closed. */
  "session:replaced": () => void;
  /** This server instance is shutting down; the client should reconnect. */
  "server:shutdown": () => void;
  "server:error": (p: { code: ErrorCode; message?: string }) => void;
  /** Shown to both sides when contact sharing or solicitation shows up in chat. */
  "safety:nudge": (p: { roomId: string; kind: "contact-sharing" | "solicitation" | "link-hidden" }) => void;
  /** Operator banner; null clears it. */
  "server:banner": (p: { message: string | null }) => void;
  /** Matching opened or closed (kill switch, staffed hours). */
  "matching:status": (p: { open: boolean; reopensAt: number | null; message: string | null }) => void;
  /** A restriction was applied to this device. Any room is ended first. */
  "session:restricted": (p: { restriction: Restriction }) => void;
}

export interface ClientToServerEvents {
  "session:hello": (p: HelloPayload, ack: (res: HelloAck) => void) => void;
  "session:preferences": (p: UpdatePreferencesPayload, ack: (res: SimpleAck) => void) => void;
  "match:accept": (p: RoomRef) => void;
  "match:decline": (p: RoomRef) => void;
  /**
   * This side's peer connection reached "connected" (sent once per call).
   * Coins and friends count from the moment both sides have sent it.
   */
  "call:connected": (p: RoomRef) => void;
  /** Ends the pending or active room. Both sides are re-queued; the pair is blocked for a while. */
  "call:skip": (p?: RoomRef) => void;
  "rtc:signal": (p: RtcSignal) => void;
  "chat:send": (p: ChatSendPayload, ack: (res: ChatAck) => void) => void;
  "chat:typing": (p: ChatTypingPayload) => void;
  /** Ends the call, blocks the pair, records the report. */
  "report:submit": (p: ReportPayload, ack: (res: ReportAck) => void) => void;
  "call:failed": (p: CallFailedPayload) => void;
  "call:telemetry": (p: CallTelemetryPayload) => void;
  "moderation:signal": (p: ModerationSignalPayload) => void;
}

/* ------------------------------------------------------------------ */
/* REST API (same origin as the socket server)                         */
/* ------------------------------------------------------------------ */

/** Bumped when the Terms change; older acceptances must be renewed. */
export const TOS_VERSION = "2026-10-draft";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * POST /api/session. Every call needs a Turnstile token (unless the server runs without one in dev).
 * First visit: send `age` with the date of birth. The server computes 18+ itself and NEVER stores
 * the date of birth, only the outcome. Returning visit: send the `ageToken` it gave you.
 * `fingerprint` is a SHA-256 hex of coarse browser traits, used only for under-18 lockouts and bans.
 */
export const sessionRequestSchema = z.object({
  deviceId: z.string().uuid(),
  fingerprint: sha256Hex,
  turnstileToken: z.string().max(4096).optional(),
  age: z
    .union([
      z.object({ dob: isoDate, attest18: z.literal(true), tosVersion: z.string().max(64) }),
      z.object({ ageToken: z.string().max(4096), tosVersion: z.string().max(64) }),
    ]),
});
export type SessionRequest = z.infer<typeof sessionRequestSchema>;

export type SessionError =
  | "invalid"
  | "underage" // this request proved the user is under 18; the device is now locked out
  | "locked" // this device or fingerprint was locked out earlier
  | "region_blocked"
  | "turnstile_failed"
  | "age_token_invalid" // ask for the date of birth again
  | "tos_outdated" // show the new Terms and ask again
  | "closed" // new sessions are disabled by the kill switch
  | "banned"
  | "rate_limited";

export type SessionResponse =
  | {
      ok: true;
      /** Short-lived (24 h). Pass it as Socket.IO auth: io(url, { auth: { sessionToken } }). */
      sessionToken: string;
      sessionExpiresAt: number;
      /** Long-lived (180 days) proof of the 18+ outcome for this device. Keep it in localStorage. */
      ageToken: string;
      ageExpiresAt: number;
      /** ISO country code the server saw, or null when unknown. */
      country: string | null;
    }
  | { ok: false; error: SessionError; restriction?: Restriction };

/** GET /api/config: public runtime configuration, safe to cache for 60 s. */
export interface PublicConfig {
  tosVersion: string;
  turnstileSiteKey: string | null;
  sentryDsn: string | null;
  posthogKey: string | null;
  posthogHost: string | null;
  banner: string | null;
  matchingOpen: boolean;
  /** Human-readable staffed window, e.g. "8 pm to midnight IST", or null when always open. */
  staffedHours: string | null;
  reopensAt: number | null;
  defaultMode: MatchMode;
  privateModeEnabled: boolean;
}

/** GET /api/restrictions/:id?deviceId=... : the restricted device reads its own restriction. */
export interface RestrictionView {
  restriction: Restriction;
  /** Present only when evidenceAvailable: a blurred-on-display JPEG data URL. */
  evidenceFrame: string | null;
}

/** POST /api/appeals. One appeal per restriction. */
export const appealRequestSchema = z.object({
  restrictionId: z.string().uuid(),
  deviceId: z.string().uuid(),
  text: z.string().trim().min(10).max(LIMITS.appealMax),
});
export type AppealRequest = z.infer<typeof appealRequestSchema>;
export type AppealResponse = { ok: true; appealId: string } | { ok: false; error: "invalid" | "not_found" | "already_appealed" | "not_appealable" | "rate_limited" };

/**
 * POST /api/takedowns: notice-and-removal (US TAKE IT DOWN Act, India IT Rules NCII 24 h).
 * Chizzy does not record calls, so most notices concern a report-time evidence frame or a profile photo.
 */
export const takedownRequestSchema = z.object({
  kind: z.enum(["ncii", "csam", "impersonation", "other"]),
  contactEmail: z.string().email().max(254),
  description: z.string().trim().min(20).max(LIMITS.takedownDescriptionMax),
  /** Where the content appeared: approximate date and time, a display name, anything that helps. */
  location: z.string().trim().max(500).optional(),
  isAffectedPerson: z.boolean(),
  goodFaithStatement: z.literal(true),
  turnstileToken: z.string().max(4096).optional(),
});
export type TakedownRequest = z.infer<typeof takedownRequestSchema>;
export type TakedownResponse = { ok: true; ticketId: string } | { ok: false; error: "invalid" | "turnstile_failed" | "rate_limited" };

/* ------------------------------------------------------------------ */
/* Admin API (/admin/api/*, Authorization: Bearer ADMIN_TOKEN)         */
/* ------------------------------------------------------------------ */

export const FLAG_DEFAULTS = {
  matching_enabled: true,
  new_sessions_enabled: true,
  max_waiting: 5_000,
  turn_enabled: true,
  private_mode_enabled: true,
  video_max_kbps: 900,
  relay_video_max_kbps: 500,
  banner_message: "",
  /** Comma-separated ISO codes. Owner decision 2026-10-04: UK, EU + EEA and Australia blocked. */
  blocked_countries:
    "GB,AU,AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,NO,IS,LI",
  /** "HH:MM-HH:MM Area/City", e.g. "20:00-24:00 Asia/Kolkata". Empty means always open. */
  staffed_hours: "",
  default_mode: "instant" as MatchMode,
  /** Show the real online count only when at least this many people are online. */
  online_count_threshold: 50,
} as const;

export const flagsSchema = z.object({
  matching_enabled: z.boolean(),
  new_sessions_enabled: z.boolean(),
  max_waiting: z.number().int().min(0).max(1_000_000),
  turn_enabled: z.boolean(),
  private_mode_enabled: z.boolean(),
  video_max_kbps: z.number().int().min(100).max(10_000),
  relay_video_max_kbps: z.number().int().min(100).max(10_000),
  banner_message: z.string().max(280),
  blocked_countries: z.string().regex(/^([A-Z]{2}(,[A-Z]{2})*)?$/),
  staffed_hours: z.string().regex(/^(\d{2}:\d{2}-\d{2}:\d{2} [A-Za-z_]+\/[A-Za-z_]+)?$/),
  default_mode: z.enum(MATCH_MODES),
  online_count_threshold: z.number().int().min(0).max(1_000_000),
});
export type Flags = z.infer<typeof flagsSchema>;

export type Severity = "critical" | "high" | "medium" | "low";

export interface AdminReport {
  id: string;
  createdAt: number;
  reason: ReportReason;
  severity: Severity;
  status: "open" | "acknowledged" | "actioned" | "dismissed" | "escalated";
  roomId: string;
  /** Stable pseudonymous ids (salted hashes), never raw device ids. */
  reporter: string;
  reported: string;
  reporterWeight: number;
  details: string | null;
  hasFrame: boolean;
  chat: Array<{ from: "reporter" | "reported"; text: string; ts: number }>;
  /** Routed to the restricted CSAM store: the frame is never served to the console. */
  restricted: boolean;
  /** Classifier score for the frame, 0..1, when available. */
  nsfwScore: number | null;
  ackDueAt: number;
  resolveDueAt: number;
  priorReportsAgainst: number;
}

export interface AdminAppeal {
  id: string;
  restrictionId: string;
  restriction: Restriction;
  text: string;
  createdAt: number;
  dueAt: number;
  status: "pending" | "upheld" | "overturned";
}

export interface AdminTakedown {
  id: string;
  kind: TakedownRequest["kind"];
  contactEmail: string;
  description: string;
  location: string | null;
  isAffectedPerson: boolean;
  createdAt: number;
  dueAt: number;
  status: "open" | "resolved";
  resolution: string | null;
}

export const adminReportActionSchema = z.object({
  action: z.enum(["acknowledge", "dismiss", "warn", "restrict", "escalate_csam"]),
  reason: z.enum(RESTRICTION_REASONS).optional(),
  /** For restrict: milliseconds, or null for permanent (humans only, which is every admin action). */
  durationMs: z.number().int().positive().nullable().optional(),
  note: z.string().max(2_000).optional(),
});
export type AdminReportAction = z.infer<typeof adminReportActionSchema>;

export const adminAppealDecisionSchema = z.object({
  decision: z.enum(["uphold", "overturn"]),
  note: z.string().max(2_000).optional(),
});

export const adminTakedownResolveSchema = z.object({ resolution: z.string().trim().min(1).max(2_000) });

export interface AdminAuditEntry {
  id: string;
  ts: number;
  action: string;
  target: string;
  note: string | null;
  ip: string | null;
}

/** Packet for NCMEC CyberTipline / India NCRP filing, built without opening the image. */
export interface CsamReportPacket {
  reportId: string;
  generatedAt: number;
  incidentAt: number;
  reason: ReportReason;
  classifierScore: number | null;
  humanViewed: boolean;
  reportedDevice: string;
  reportedIpAddress: string | null;
  reportedCountry: string | null;
  evidenceSha256: string | null;
  evidencePreservedUntil: number;
  chat: AdminReport["chat"];
}
