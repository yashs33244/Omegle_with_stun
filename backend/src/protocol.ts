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

/** Spark icebreakers: one shared prompt shown to both sides at the same moment. */
export const SPARK = {
  /** Minimum gap between two prompts in one room; both sides share the cooldown. */
  cooldownMs: 10_000,
  /** How long a client keeps the prompt card on screen. */
  cardMs: 12_000,
  /** The server does not repeat any of the last N prompt ids of a room. */
  historySize: 20,
} as const;

/** Live captions: the sender's browser transcribes its own speech; the server only relays. */
export const CAPTIONS = {
  /** UTF-8 bytes of one segment's text. */
  maxBytes: 1_024,
  /** Segments per second per socket; the rest are dropped. */
  maxPerSec: 10,
  /** Interim segments are sent at most this often; finals go out at once. */
  interimEveryMs: 250,
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

export const sparkRequestSchema = roomRefSchema;

/** Byte length as the wire sees it, so a 1 KB cap means 1 KB in any script. */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * One piece of the sender's own transcript. Relayed to the partner only,
 * never stored or logged. Later segments with the same id replace earlier
 * (interim) ones until `final`.
 */
export const captionSegmentSchema = z.object({
  roomId,
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  text: z
    .string()
    .trim()
    .min(1)
    .refine((text) => utf8Bytes(text) <= CAPTIONS.maxBytes, { message: `text must be at most ${CAPTIONS.maxBytes} bytes` }),
  final: z.boolean(),
  /** Language the sender's recogniser ran in; the receiver translates from it. */
  lang: languageCode,
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
export type CaptionSegmentPayload = z.infer<typeof captionSegmentSchema>;

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
  | "premium_required" // genderFilter other than "all" needs an active gender_filter unlock (see /api/billing)
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
  /** The gender filter in effect: "all" when the one sent needs an unlock the device does not have. */
  genderFilter: GenderFilter;
}>;
export type ChatAck = Ack<{ id: string; ts: number; redacted: boolean }>;
export type ReportAck = Ack<{ reportId: string }>;
export type SparkAck = Ack<{ promptId: string }>;
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
  /** Coins and premium unlocks, sent after session:hello and after every purchase, unlock or admin adjustment. */
  "wallet:update": (p: WalletView) => void;
  /**
   * An icebreaker for both members, sent at the same moment. `from` says whose
   * tap it was. The id maps to text in each client's own language
   * (new-frontend/public/spark/prompts.<lang>.json, generated from backend/src/spark/catalog.ts).
   */
  "spark:show": (p: { roomId: string; promptId: string; from: "you" | "partner"; at: number }) => void;
  /** The partner's live caption, as their own browser transcribed it. */
  "caption:segment": (p: CaptionSegmentPayload) => void;
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
  /** Ask for a Spark prompt; both sides get spark:show. rate_limited while the room cooldown runs. */
  "spark:request": (p: RoomRef, ack: (res: SparkAck) => void) => void;
  /** A piece of my own transcript for the partner. Dropped over CAPTIONS.maxPerSec. */
  "caption:segment": (p: CaptionSegmentPayload) => void;
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
/* Billing (/api/billing/*, coins and premium unlocks)                 */
/* ------------------------------------------------------------------ */

/** Features a device can unlock for a period by spending coins. */
export const PREMIUM_FEATURES = ["gender_filter"] as const;
export type PremiumFeature = (typeof PREMIUM_FEATURES)[number];

/** Unlock periods offered to users, in days. The price is `gender_filter_coins_per_day` x days. */
export const UNLOCK_DAYS = [1, 7, 30] as const;
export type UnlockDays = (typeof UNLOCK_DAYS)[number];

/** One purchasable coin pack (flag `coin_packs`). `inr` is the price in whole rupees. */
export const coinPackSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  coins: z.number().int().min(1).max(1_000_000),
  inr: z.number().int().min(1).max(100_000),
});
export const coinPacksSchema = z.array(coinPackSchema).min(1).max(10);
export type CoinPack = z.infer<typeof coinPackSchema>;

export interface PremiumUnlock {
  feature: PremiumFeature;
  /** Epoch ms. */
  expiresAt: number;
}

/** GET /api/billing/wallet and the wallet:update event. Only unlocks that are still active. */
export interface WalletView {
  coins: number;
  unlocks: PremiumUnlock[];
}

/** GET /api/billing/packs: public, safe to cache for 30 s. */
export interface BillingPacksResponse {
  /** Razorpay is configured; orders can be created. */
  enabled: boolean;
  /** Flag premium_filters_enabled: false makes the gender filter free. */
  premiumFiltersEnabled: boolean;
  /** Razorpay key id for Checkout, null when billing is disabled. */
  keyId: string | null;
  /** Coins charged per day of gender_filter. */
  costPerDay: number;
  packs: CoinPack[];
  unlockDays: readonly UnlockDays[];
}

export const billingOrderRequestSchema = z.object({ packId: coinPackSchema.shape.id });
export type BillingOrderRequest = z.infer<typeof billingOrderRequestSchema>;

/** POST /api/billing/orders: what Razorpay Checkout needs. `amount` is in paise. */
export interface BillingOrder {
  orderId: string;
  amount: number;
  currency: "INR";
  keyId: string;
  packId: string;
  coins: number;
}

/** POST /api/billing/verify: the Checkout success handler's payload. */
export const billingVerifyRequestSchema = z.object({
  orderId: z.string().min(1).max(64),
  paymentId: z.string().min(1).max(64),
  signature: z.string().min(1).max(256),
});
export type BillingVerifyRequest = z.infer<typeof billingVerifyRequestSchema>;

export const billingUnlockRequestSchema = z.object({
  feature: z.enum(PREMIUM_FEATURES),
  days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
});
export type BillingUnlockRequest = z.infer<typeof billingUnlockRequestSchema>;

export type BillingError =
  | "billing_disabled" // no Razorpay keys on the server
  | "session_required" // missing, invalid or expired session token (Authorization: Bearer)
  | "invalid"
  | "rate_limited"
  | "unknown_pack"
  | "order_unknown" // this server never created (or has lost) the order; nothing is credited
  | "bad_signature"
  | "payment_mismatch" // the payment does not match the order (amount, currency, device or status)
  | "payment_pending" // Razorpay has authorized but not yet captured the payment; retry, or wait for the webhook
  | "insufficient_coins"
  | "upstream"; // Razorpay did not answer

export type BillingResponse<T> = ({ ok: true } & T) | { ok: false; error: BillingError };

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
  /** Owner decision 2026-10-11: the gender filter costs coins. false makes it free again. */
  premium_filters_enabled: true,
  gender_filter_coins_per_day: 100,
  /** JSON array of coin packs (coinPacksSchema). Sized so 99 INR is about a week and 299 INR about a month. */
  coin_packs: '[{"id":"week","coins":700,"inr":99},{"id":"month","coins":3000,"inr":299}]',
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
  premium_filters_enabled: z.boolean(),
  gender_filter_coins_per_day: z.number().int().min(1).max(100_000),
  coin_packs: z
    .string()
    .max(2_000)
    .refine((s) => {
      try {
        return coinPacksSchema.safeParse(JSON.parse(s)).success;
      } catch {
        return false;
      }
    }, "must be a JSON array of {id, coins, inr}"),
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

/** Coin movements, newest first. `ref` is the room, payment id or admin note. */
export interface WalletLedgerEntry {
  id: string;
  deviceId: string;
  delta: number;
  reason: "earned" | "purchase" | "unlock" | "admin";
  ref: string | null;
  at: number;
}

/** GET /admin/api/wallets/:deviceId */
export interface AdminWalletView extends WalletView {
  deviceId: string;
  ledger: WalletLedgerEntry[];
}

export const adminWalletAdjustSchema = z.object({
  delta: z.number().int().min(-1_000_000).max(1_000_000).refine((d) => d !== 0, "must not be 0"),
  note: z.string().trim().min(1).max(500),
});
export type AdminWalletAdjust = z.infer<typeof adminWalletAdjustSchema>;

/** A Razorpay order this server created (GET /admin/api/billing/orders, newest first). */
export interface BillingOrderRecord {
  orderId: string;
  deviceId: string;
  packId: string;
  coins: number;
  /** Paise. */
  amount: number;
  currency: "INR";
  status: "created" | "paid";
  paymentId: string | null;
  createdAt: number;
  paidAt: number | null;
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
