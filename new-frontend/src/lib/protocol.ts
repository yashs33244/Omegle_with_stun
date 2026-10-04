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

export const PROTOCOL_VERSION = 2;

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

export const reportSchema = z.object({
  roomId,
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(LIMITS.reportDetailsMax).optional(),
});

export type HelloPayload = z.infer<typeof helloSchema>;
export type UpdatePreferencesPayload = z.infer<typeof updatePreferencesSchema>;
export type RoomRef = z.infer<typeof roomRefSchema>;
export type RtcSignal = z.infer<typeof rtcSignalSchema>;
export type ChatSendPayload = z.infer<typeof chatSendSchema>;
export type ChatTypingPayload = z.infer<typeof chatTypingSchema>;
export type ReportPayload = z.infer<typeof reportSchema>;

/* ------------------------------------------------------------------ */
/* Acks                                                                */
/* ------------------------------------------------------------------ */

export type ErrorCode =
  | "invalid_payload"
  | "rate_limited"
  | "not_in_room"
  | "bad_state"
  | "unsupported_version"
  | "banned"
  | "internal";

export type Ack<T = object> = ({ ok: true } & T) | { ok: false; error: ErrorCode; message?: string };

export type HelloAck = Ack<{ coins: number; iceServers: IceServer[] }>;
export type ChatAck = Ack<{ id: string; ts: number }>;
export type SimpleAck = Ack;

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export type MatchEndReason =
  | "declined" // you pressed Pass
  | "partner-declined"
  | "timeout" // nobody accepted within the accept window
  | "skipped" // you skipped
  | "partner-skipped"
  | "partner-left" // partner disconnected or closed the tab
  | "reported" // you reported the partner (call ends, pair is blocked)
  | "partner-unavailable"; // server-side cleanup (instance died, session replaced)

/**
 * Lifecycle (server-authoritative):
 *   session:hello -> queue:waiting -> match:found -> (both match:accept) -> call:start
 *   -> rtc:signal relay -> ... -> match:ended -> queue:waiting (auto re-queue)
 * Disconnecting the socket (Home button, tab close) ends any room and notifies the partner.
 * After match:ended the server re-queues the user automatically, except after a ban.
 */
export interface ServerToClientEvents {
  "queue:waiting": () => void;
  "match:found": (p: {
    roomId: string;
    partner: PublicProfile;
    /** The two devices became friends in an earlier call. */
    isFriend: boolean;
    /** Epoch ms after which the server auto-skips if both have not accepted. */
    expiresAt: number;
    /** Server clock at emit time, so clients can correct clock skew. */
    serverNow: number;
  }) => void;
  "match:partner-accepted": (p: { roomId: string }) => void;
  "match:ended": (p: { roomId: string; reason: MatchEndReason }) => void;
  /** Both accepted. The initiator creates the offer; the other side answers. */
  "call:start": (p: { roomId: string; initiator: boolean }) => void;
  "rtc:signal": (p: RtcSignal) => void;
  "chat:message": (p: { roomId: string; id: string; text: string; ts: number }) => void;
  "chat:typing": (p: { roomId: string; typing: boolean }) => void;
  "coins:update": (p: { balance: number; delta: number }) => void;
  /** Sent to both sides after 5 minutes of continuous call. */
  "friends:new": (p: { roomId: string }) => void;
  /** The same deviceId connected from another tab; this socket is about to be closed. */
  "session:replaced": () => void;
  /** This server instance is shutting down; the client should reconnect. */
  "server:shutdown": () => void;
  "server:error": (p: { code: ErrorCode; message?: string }) => void;
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
  "report:submit": (p: ReportPayload, ack: (res: SimpleAck) => void) => void;
}
