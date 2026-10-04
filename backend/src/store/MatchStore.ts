/**
 * Storage contract for matchmaking state.
 *
 * Two implementations: MemoryStore (single instance, tests) and RedisStore
 * (N instances sharing one Redis). MatchService only talks to this interface.
 *
 * Rules every implementation must follow (enforced by test/storeContract.ts):
 * - All methods are async and may be called concurrently.
 * - Values are copied in and out (like JSON round trips). Mutating an object
 *   returned by a getter must never change stored state, and mutating an
 *   object after passing it to a setter must not either.
 * - Time based expiry uses the wall clock (Date.now()) at call time.
 * - withLock() runs `fn` while holding ONE store-wide mutual exclusion lock
 *   (Redis: key `lock:match`, SET NX PX with a random token, Lua compare and
 *   delete release, retry with jittered backoff). It is NOT reentrant:
 *   calling withLock() inside `fn` deadlocks (memory) or times out (Redis).
 *   MatchService runs every read-modify-write that touches two sessions or a
 *   room inside withLock(); single-key atomic operations (coins, friends,
 *   reports, bans) do not need it.
 */
import type { Preferences, Profile, ReportReason } from "../protocol";

export type SessionState = "idle" | "waiting" | "pending" | "active";

/**
 * Profile as stored on a session. The photo (up to ~150 KB) lives under its
 * own key (setPhoto/getPhoto) so match passes never load or copy it.
 */
export type SessionProfile = Omit<Profile, "photo">;

/** One connected socket that completed session:hello. */
export interface Session {
  socketId: string;
  deviceId: string;
  /** config.instanceId of the server that owns the socket. */
  instanceId: string;
  profile: SessionProfile;
  preferences: Preferences;
  state: SessionState;
  /** Set while state is pending or active. */
  roomId?: string;
  /** Set while state is waiting. Epoch ms. */
  waitingSince?: number;
  connectedAt: number;
}

export interface Room {
  id: string;
  state: "pending" | "active";
  /** Socket ids. members[0] is the older waiter and becomes the WebRTC initiator. */
  members: [string, string];
  devices: [string, string];
  accepted: [boolean, boolean];
  createdAt: number;
  /** Accept deadline (epoch ms) while pending. */
  expiresAt: number;
  /** Set when both accepted. */
  activeSince?: number;
}

/** Block between two devices. Kept past `until` so repeated skips escalate. */
export interface PairBlock {
  until: number;
  skipCount: number;
}

export interface ReportRecord {
  reporterDevice: string;
  reportedDevice: string;
  roomId: string;
  reason: ReportReason;
  details?: string;
  ts: number;
}

export interface StoreStats {
  sessions: number;
  waiting: number;
  pendingRooms: number;
  activeRooms: number;
}

export interface MatchStore {
  /** Resolves when the backing store answers; rejects otherwise (used by /readyz). */
  ping(): Promise<void>;

  /** Runs fn under the store-wide matchmaking lock. Not reentrant. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;

  /* Sessions */
  getSession(socketId: string): Promise<Session | null>;
  /** Same order as the input; null for missing ids. */
  getSessions(socketIds: string[]): Promise<(Session | null)[]>;
  putSession(session: Session): Promise<void>;
  /** Deletes the session and its photo. */
  deleteSession(socketId: string): Promise<void>;

  /* Profile photo per socket (data URL), stored apart from the session */
  /** null removes it. */
  setPhoto(socketId: string, photo: string | null): Promise<void>;
  getPhoto(socketId: string): Promise<string | null>;

  /* deviceId -> socketId binding (one live socket per device) */
  getDeviceSocket(deviceId: string): Promise<string | null>;
  setDeviceSocket(deviceId: string, socketId: string): Promise<void>;
  /** Removes the binding only if it still points at socketId. */
  clearDeviceSocket(deviceId: string, socketId: string): Promise<void>;

  /* Waiting queue */
  /** Adds or re-scores socketId. */
  addWaiting(socketId: string, since: number): Promise<void>;
  removeWaiting(socketId: string): Promise<void>;
  /** Oldest first by `since`. Ties come back in a stable but unspecified order. */
  listWaiting(): Promise<string[]>;

  /* Rooms */
  getRoom(roomId: string): Promise<Room | null>;
  /** Insert or replace. Pending rooms are indexed by expiresAt for the sweeper. */
  putRoom(room: Room): Promise<void>;
  deleteRoom(roomId: string): Promise<void>;
  /** Ids of pending rooms whose expiresAt <= cutoff, oldest deadline first. */
  listExpiredPendingRooms(cutoff: number): Promise<string[]>;

  /* Coins, per device */
  /** Stored balance, or null if the device never had coins. */
  getCoins(deviceId: string): Promise<number | null>;
  /** Atomically adds delta, starting from `initial` if unset. Returns the new balance. */
  addCoins(deviceId: string, delta: number, initial: number): Promise<number>;

  /* Friends, symmetric pairs of devices */
  areFriends(deviceA: string, deviceB: string): Promise<boolean>;
  /** Idempotent. */
  addFriends(deviceA: string, deviceB: string): Promise<void>;

  /* Pair blocks, symmetric */
  /** The record if still retained, even when `until` has passed. */
  getBlock(deviceA: string, deviceB: string): Promise<PairBlock | null>;
  /** Stores the record and keeps it for retainMs from now. */
  setBlock(deviceA: string, deviceB: string, block: PairBlock, retainMs: number): Promise<void>;

  /* Reports */
  /** Appends to the report log (capped) and indexes the reporter against the reported device. */
  addReport(report: ReportRecord): Promise<void>;
  /** Number of distinct reporter devices with a report against deviceId at or after `since`. */
  countReporters(deviceId: string, since: number): Promise<number>;

  /* Bans */
  /** Ban expiry (epoch ms) if the device is banned now, else null. */
  getBan(deviceId: string): Promise<number | null>;
  setBan(deviceId: string, until: number): Promise<void>;

  /* Instances (several servers sharing one store) */
  /** Marks the instance alive for ttlMs and remembers it until forgetInstance(). */
  heartbeat(instanceId: string, ttlMs: number): Promise<void>;
  /** Instances that sent a heartbeat once but whose last one has lapsed. */
  listDeadInstances(): Promise<string[]>;
  /** Socket ids of the stored sessions owned by instanceId (any order). */
  listInstanceSessions(instanceId: string): Promise<string[]>;
  /** Drops the instance: its heartbeat, its entry in the instance list and its session index. */
  forgetInstance(instanceId: string): Promise<void>;

  stats(): Promise<StoreStats>;

  /** Releases connections. The store is unusable afterwards. */
  close(): Promise<void>;
}

/** Canonical key for a symmetric device pair. */
export function pairKey(deviceA: string, deviceB: string): string {
  return deviceA < deviceB ? `${deviceA}:${deviceB}` : `${deviceB}:${deviceA}`;
}

/** Max entries kept in the report log. */
export const REPORT_LOG_MAX = 10_000;
