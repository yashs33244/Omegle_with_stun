/**
 * All matchmaking and call-lifecycle rules (see .planning/PLAN.md, "Domain rules").
 *
 * State lives in a MatchStore so several instances can share it. Emits go
 * through an Emitter keyed by socket id, which works across instances when
 * Socket.IO has a cross-instance adapter.
 *
 * Locking: every operation that reads and then writes sessions or rooms runs
 * inside store.withLock(). The lock is not reentrant, so methods ending in
 * `Locked` assume the caller already holds it and never take it again.
 */
import { randomUUID } from "node:crypto";
import type { Config } from "../config";
import type { FlagsReader } from "../flags/flags";
import type { Logger } from "../logger";
import type { Metrics } from "../metrics";
import type { QueueGate } from "../session/queueGate";
import type {
  ChatAck,
  ChatSendPayload,
  ChatTypingPayload,
  HelloAck,
  HelloPayload,
  MatchEndReason,
  PublicProfile,
  ReportAck,
  ReportPayload,
  RtcSignal,
  ServerToClientEvents,
  SimpleAck,
  UpdatePreferencesPayload,
} from "../protocol";
import type { MatchStore, Room, Session, SessionProfile } from "../store/MatchStore";
import { buildIceServers } from "../turn";
import { isCompatible } from "./compatibility";

/** How long a pair block record is remembered after it lapses, so repeated skips escalate. */
const BLOCK_MEMORY_MS = 24 * 60 * 60_000;

export interface Emitter {
  emit<E extends keyof ServerToClientEvents>(
    socketId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void;
  /** Disconnects a socket on whichever instance owns it. */
  disconnect(socketId: string): void;
  /** True if the socket is connected to THIS instance. */
  isLocalConnected(socketId: string): boolean;
}

export type Reply<T> = (res: T) => void;

export interface MatchServiceDeps {
  store: MatchStore;
  config: Config;
  logger: Logger;
  metrics: Metrics;
  emitter: Emitter;
  /** Operator flags (kill switch, staffed hours, bitrate caps). */
  flags: FlagsReader;
  /** Who may join the queue (kill switch, staffed hours, max_waiting, hourly caps). Open when unset. */
  gate?: QueueGate;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Per-socket bookkeeping for sockets owned by this instance. */
interface LocalSocket {
  deviceId: string;
  /** Set when a sweep found no stored session for this socket (see tickRewards). */
  orphaned?: boolean;
  rewards?: {
    roomId: string;
    activeSince: number;
    partnerDevice: string;
    intervalsAwarded: number;
    friended: boolean;
  };
}

export function publicProfile(profile: SessionProfile, photo: string | null): PublicProfile {
  const { gender: _gender, ...rest } = profile;
  return photo ? { ...rest, photo } : rest;
}

export class MatchService {
  private readonly store: MatchStore;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly metrics: Metrics;
  private readonly emitter: Emitter;
  private readonly flags: FlagsReader;
  private readonly gate?: QueueGate;
  private readonly now: () => number;
  private readonly local = new Map<string, LocalSocket>();
  /** Sessions queued or changed since the last match pass (only touched under the lock). */
  private readonly dirty = new Set<string>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private started?: Promise<void>;
  private sweeping?: Promise<void>;
  private stopped = false;
  private lastFullPassAt = 0;
  private lastReapAt = 0;

  constructor(deps: MatchServiceDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.log = deps.logger;
    this.metrics = deps.metrics;
    this.emitter = deps.emitter;
    this.flags = deps.flags;
    this.gate = deps.gate;
    this.now = deps.now ?? Date.now;
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Starts the sweeper and the instance heartbeat. Resolves after the first
   * heartbeat is stored, so other instances never see this instance's
   * sessions before they see it alive. Idempotent.
   */
  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.started) return this.started;
    this.sweepTimer = setInterval(() => void this.sweep(), this.config.sweepIntervalMs);
    this.sweepTimer.unref?.();
    // Separate from the sweeper: a sweep stuck waiting for the lock must not
    // let the heartbeat lapse and get this live instance reaped.
    this.heartbeatTimer = setInterval(() => {
      this.beat().catch((err: unknown) => this.log.error({ err }, "instance heartbeat failed"));
    }, this.config.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
    this.started = this.beat();
    return this.started;
  }

  private beat(): Promise<void> {
    return this.store.heartbeat(this.config.instanceId, this.config.instanceTtlMs);
  }

  /**
   * Graceful shutdown: stop the sweeper, tell local sockets, and remove their
   * sessions so partners on other instances are re-queued.
   */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.sweepTimer = undefined;
    this.heartbeatTimer = undefined;
    await this.sweeping;
    const ids = [...this.local.keys()];
    for (const id of ids) this.emitter.emit(id, "server:shutdown");
    await this.store.withLock(async () => {
      const sessions = await this.store.getSessions(ids);
      for (const s of sessions) if (s) await this.removeSessionLocked(s, "partner-unavailable");
      // Also sessions the local map lost track of, then the instance itself.
      for (const socketId of await this.store.listInstanceSessions(this.config.instanceId)) {
        const s = await this.store.getSession(socketId);
        if (s) await this.removeSessionLocked(s, "partner-unavailable");
      }
      await this.store.forgetInstance(this.config.instanceId);
    });
    this.local.clear();
  }

  /** Number of sockets with a session on this instance. */
  localSessionCount(): number {
    return this.local.size;
  }

  /* ---------------------------------------------------------------- */
  /* Client events                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * session:hello. The ack is sent through `reply` inside the lock, before
   * queue:waiting or match:found, so clients always see the ack first.
   */
  async hello(socketId: string, payload: HelloPayload, reply: Reply<HelloAck>): Promise<void> {
    if (this.stopped) return reply({ ok: false, error: "internal", message: "server shutting down" });
    const { deviceId } = payload;
    if (await this.store.getBan(deviceId)) return reply({ ok: false, error: "banned" });

    await this.store.withLock(async () => {
      // The socket may have disconnected while we waited for the lock.
      if (!this.emitter.isLocalConnected(socketId)) return reply({ ok: false, error: "bad_state" });
      const now = this.now();
      const { photo, ...profile } = payload.profile;
      let session = await this.store.getSession(socketId);

      if (session && session.deviceId !== deviceId) {
        return reply({ ok: false, error: "bad_state", message: "deviceId cannot change on a live socket" });
      }
      // Gate only hellos that would join the queue; a re-hello mid-call just updates the profile.
      if (!session || session.state === "idle") {
        const refused = await this.gate?.admit(deviceId);
        if (refused) return reply({ ok: false, ...refused });
      }

      if (!session) {
        const previous = await this.store.getDeviceSocket(deviceId);
        if (previous && previous !== socketId) await this.replaceLocked(previous);
        session = {
          socketId,
          deviceId,
          instanceId: this.config.instanceId,
          profile,
          preferences: payload.preferences,
          mode: payload.mode,
          state: "idle",
          connectedAt: now,
        };
        await this.store.setDeviceSocket(deviceId, socketId);
      } else {
        session.profile = profile;
        session.preferences = payload.preferences;
        session.mode = payload.mode;
      }
      await this.store.putSession(session);
      await this.store.setPhoto(socketId, photo ?? null);
      this.local.set(socketId, this.local.get(socketId) ?? { deviceId });

      const coins = (await this.store.getCoins(deviceId)) ?? this.config.initialCoins;
      reply({ ok: true, coins, iceServers: buildIceServers(this.config, deviceId, now), mode: payload.mode });

      if (session.state === "idle" || session.state === "waiting") {
        await this.enqueueLocked(session, session.state === "waiting" ? session.waitingSince : undefined);
        await this.matchPassLocked();
      }
    });
  }

  async updatePreferences(socketId: string, payload: UpdatePreferencesPayload, reply: Reply<SimpleAck>): Promise<void> {
    await this.store.withLock(async () => {
      const session = await this.store.getSession(socketId);
      if (!session) return reply({ ok: false, error: "bad_state", message: "send session:hello first" });
      session.preferences = payload.preferences;
      await this.store.putSession(session);
      reply({ ok: true });
      if (session.state === "waiting") {
        this.dirty.add(socketId);
        await this.matchPassLocked();
      }
    });
  }

  async accept(socketId: string, roomId: string): Promise<void> {
    await this.store.withLock(async () => {
      const found = await this.memberRoomLocked(socketId, roomId);
      if (!found || found.room.state !== "pending") return;
      const { room, index } = found;
      if (this.now() > room.expiresAt + this.config.matchAcceptGraceMs) return; // the sweeper ends it
      if (room.accepted[index]) return;
      room.accepted[index] = true;
      const other = room.members[1 - index]!;

      if (!room.accepted[0] || !room.accepted[1]) {
        await this.store.putRoom(room);
        this.emitter.emit(other, "match:partner-accepted", { roomId });
        return;
      }

      const now = this.now();
      room.state = "active";
      room.activeSince = now;
      await this.store.putRoom(room);
      const sessions = await this.store.getSessions(room.members);
      for (const s of sessions) {
        if (s && s.roomId === room.id) {
          s.state = "active";
          await this.store.putSession(s);
        }
      }
      // Protocol v3 fields: per-call TURN credentials and bitrate caps arrive with the backend-match lane.
      const media = {
        iceServers: buildIceServers(this.config, sessions[0]?.deviceId ?? roomId, now),
        maxBitrateKbps: 900,
        relayMaxBitrateKbps: 500,
        privateModeAllowed: false,
      };
      this.emitter.emit(room.members[0], "call:start", { roomId, initiator: true, ...media });
      this.emitter.emit(room.members[1], "call:start", { roomId, initiator: false, ...media });
      this.log.info({ roomId }, "call started");
    });
  }

  async decline(socketId: string, roomId: string): Promise<void> {
    await this.store.withLock(async () => {
      const found = await this.memberRoomLocked(socketId, roomId);
      if (!found || found.room.state !== "pending") return;
      const { room, index } = found;
      await this.blockPairLocked(room, this.config.declineBlockMs, false);
      await this.endRoomLocked(room, "declined", {
        [room.members[index]]: "declined",
        [room.members[1 - index]!]: "partner-declined",
      });
      await this.matchPassLocked();
    });
  }

  /** call:skip ends the caller's pending or active room. */
  async skip(socketId: string): Promise<void> {
    await this.store.withLock(async () => {
      const session = await this.store.getSession(socketId);
      if (!session?.roomId) return;
      const found = await this.memberRoomLocked(socketId, session.roomId);
      if (!found) return;
      const { room, index } = found;
      await this.blockPairLocked(room, 0, true);
      await this.endRoomLocked(room, "skipped", {
        [room.members[index]]: "skipped",
        [room.members[1 - index]!]: "partner-skipped",
      });
      await this.matchPassLocked();
    });
  }

  async report(socketId: string, payload: ReportPayload, reply: Reply<ReportAck>): Promise<void> {
    await this.store.withLock(async () => {
      const session = await this.store.getSession(socketId);
      if (!session) return reply({ ok: false, error: "bad_state", message: "send session:hello first" });
      const found = await this.memberRoomLocked(socketId, payload.roomId);
      if (!found) return reply({ ok: false, error: "not_in_room" });
      const { room, index } = found;
      const now = this.now();
      const reportedSocket = room.members[1 - index]!;
      const reportedDevice = room.devices[1 - index]!;

      await this.store.addReport({
        reporterDevice: session.deviceId,
        reportedDevice,
        roomId: room.id,
        reason: payload.reason,
        details: payload.details || undefined,
        ts: now,
      });
      await this.blockPairLocked(room, this.config.reportBlockMs, false);

      const reporters = await this.store.countReporters(reportedDevice, now - this.config.reportWindowMs);
      const banned = reporters >= this.config.reportsToBan;
      if (banned) await this.store.setBan(reportedDevice, now + this.config.banMs);

      reply({ ok: true, reportId: randomUUID() });
      // The reported side only learns that the partner moved on.
      await this.endRoomLocked(room, "reported", {
        [socketId]: "reported",
        [reportedSocket]: "partner-skipped",
      });
      if (banned) {
        this.emitter.emit(reportedSocket, "server:error", { code: "banned" });
        this.log.warn({ roomId: room.id, reporters }, "device banned after reports");
      }
      await this.matchPassLocked();
    });
  }

  /** rtc:signal is relayed, unchanged, only to the other member of the sender's ACTIVE room. */
  async signal(socketId: string, payload: RtcSignal): Promise<void> {
    const partner = await this.activePartner(socketId, payload.roomId);
    if (partner) this.emitter.emit(partner, "rtc:signal", payload);
  }

  async chat(socketId: string, payload: ChatSendPayload, reply: Reply<ChatAck>): Promise<void> {
    const partner = await this.activePartner(socketId, payload.roomId);
    if (!partner) return reply({ ok: false, error: "not_in_room" });
    const id = randomUUID();
    const ts = this.now();
    this.emitter.emit(partner, "chat:message", { roomId: payload.roomId, id, text: payload.text, ts, redacted: false });
    reply({ ok: true, id, ts, redacted: false });
  }

  async typing(socketId: string, payload: ChatTypingPayload): Promise<void> {
    const partner = await this.activePartner(socketId, payload.roomId);
    if (partner) this.emitter.emit(partner, "chat:typing", { roomId: payload.roomId, typing: payload.typing });
  }

  async disconnect(socketId: string): Promise<void> {
    this.local.delete(socketId);
    await this.store.withLock(async () => {
      // Again under the lock: a hello that held the lock may have re-added it.
      this.local.delete(socketId);
      const session = await this.store.getSession(socketId);
      if (!session) return;
      await this.removeSessionLocked(session, "partner-left");
      await this.matchPassLocked();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Sweeper                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Removes the sessions of dead instances, expires pending rooms, runs a
   * match pass, then awards coins and friends to local sockets.
   */
  sweep(): Promise<void> {
    if (this.sweeping || this.stopped) return this.sweeping ?? Promise.resolve();
    this.sweeping = this.runSweep().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async runSweep(): Promise<void> {
    try {
      await this.store.withLock(async () => {
        const now = this.now();
        if (now - this.lastReapAt >= this.config.heartbeatIntervalMs) {
          this.lastReapAt = now;
          await this.reapDeadInstancesLocked();
        }
        const expired = await this.store.listExpiredPendingRooms(now - this.config.matchAcceptGraceMs);
        for (const roomId of expired) {
          const room = await this.store.getRoom(roomId);
          if (!room || room.state !== "pending") continue;
          await this.blockPairLocked(room, this.config.declineBlockMs, false);
          await this.endRoomLocked(room, "timeout", {
            [room.members[0]]: "timeout",
            [room.members[1]]: "timeout",
          });
        }
        // Full pass now and then: picks up users queued on other instances and lapsed blocks.
        const full = now - this.lastFullPassAt >= this.config.fullMatchPassIntervalMs;
        if (full) this.lastFullPassAt = now;
        await this.matchPassLocked(full);
      });
      await this.tickRewards();
    } catch (err) {
      this.log.error({ err }, "sweep failed");
    }
  }

  /**
   * Another instance stopped sending heartbeats (crash, kill, network split):
   * remove its sessions so their partners are told and re-queued, and so
   * nobody is matched with a socket that no longer exists.
   */
  private async reapDeadInstancesLocked(): Promise<void> {
    const dead = (await this.store.listDeadInstances()).filter((id) => id !== this.config.instanceId);
    for (const instanceId of dead) {
      const socketIds = await this.store.listInstanceSessions(instanceId);
      for (const socketId of socketIds) {
        // Read each one fresh: removing a session re-queues its partner.
        const session = await this.store.getSession(socketId);
        if (session) await this.removeSessionLocked(session, "partner-unavailable");
      }
      await this.store.forgetInstance(instanceId);
      this.log.warn({ deadInstance: instanceId, sessions: socketIds.length }, "removed sessions of a dead instance");
    }
  }

  /** Runs one full match pass under the lock (exposed for tests and multi-instance pickup). */
  matchPass(): Promise<void> {
    return this.store.withLock(() => this.matchPassLocked(true));
  }

  /**
   * Coins and friends for sockets owned by this instance. Driven by the
   * sweeper from stored room state, so it works no matter which instance
   * activated the room, and stops by itself when the room ends.
   */
  private async tickRewards(): Promise<void> {
    const ids = [...this.local.keys()];
    if (ids.length === 0) return;
    const sessions = await this.store.getSessions(ids);
    const now = this.now();
    for (let i = 0; i < ids.length; i++) {
      const socketId = ids[i]!;
      const entry = this.local.get(socketId);
      const session = sessions[i];
      if (!entry) continue;
      if (!session) {
        // The session was removed behind our back. Usually the device was
        // replaced on another instance and that instance's disconnect is a
        // few ms away, so wait one more sweep. If it is still here, this
        // instance was reaped after its heartbeat lapsed: the socket is
        // unusable, so ask the client to reconnect (it re-sends hello).
        if (!entry.orphaned) {
          entry.orphaned = true;
          continue;
        }
        this.local.delete(socketId);
        this.log.warn({ socketId }, "local socket lost its session; disconnecting it");
        this.emitter.emit(socketId, "server:shutdown");
        this.emitter.disconnect(socketId);
        continue;
      }
      entry.orphaned = false;
      if (session.state !== "active" || !session.roomId) {
        entry.rewards = undefined;
        continue;
      }
      if (entry.rewards?.roomId !== session.roomId) {
        const room = await this.store.getRoom(session.roomId);
        if (!room || room.state !== "active" || room.activeSince === undefined) continue;
        const index = room.members.indexOf(socketId);
        if (index < 0) continue;
        entry.rewards = {
          roomId: room.id,
          activeSince: room.activeSince,
          partnerDevice: room.devices[1 - index]!,
          intervalsAwarded: 0,
          friended: false,
        };
      }
      const r = entry.rewards;
      const elapsed = now - r.activeSince;
      const due = Math.floor(elapsed / this.config.coinIntervalMs);
      if (due > r.intervalsAwarded) {
        const delta = (due - r.intervalsAwarded) * this.config.coinsPerInterval;
        r.intervalsAwarded = due;
        const balance = await this.store.addCoins(session.deviceId, delta, this.config.initialCoins);
        this.emitter.emit(socketId, "coins:update", { balance, delta });
      }
      if (!r.friended && elapsed >= this.config.friendAfterMs) {
        r.friended = true;
        await this.store.addFriends(session.deviceId, r.partnerDevice);
        this.emitter.emit(socketId, "friends:new", { roomId: r.roomId });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Internals (caller holds the lock unless stated otherwise)         */
  /* ---------------------------------------------------------------- */

  /** No lock needed: a read-only membership check for relays. */
  private async activePartner(socketId: string, roomId: string): Promise<string | null> {
    const session = await this.store.getSession(socketId);
    if (!session || session.state !== "active" || session.roomId !== roomId) return null;
    const room = await this.store.getRoom(roomId);
    if (!room || room.state !== "active") return null;
    const index = room.members.indexOf(socketId);
    return index < 0 ? null : room.members[1 - index]!;
  }

  private async memberRoomLocked(socketId: string, roomId: string): Promise<{ room: Room; index: 0 | 1 } | null> {
    const session = await this.store.getSession(socketId);
    if (!session || session.roomId !== roomId) return null;
    const room = await this.store.getRoom(roomId);
    if (!room) return null;
    const index = room.members.indexOf(socketId);
    if (index < 0) return null;
    return { room, index: index as 0 | 1 };
  }

  private async enqueueLocked(session: Session, since?: number): Promise<void> {
    session.state = "waiting";
    session.roomId = undefined;
    session.waitingSince = since ?? this.now();
    await this.store.putSession(session);
    await this.store.addWaiting(session.socketId, session.waitingSince);
    this.dirty.add(session.socketId);
    this.emitter.emit(session.socketId, "queue:waiting", { relaxStep: 0 });
  }

  /**
   * Deletes a room and tells each member why. Members with a reason are
   * re-queued (unless banned); members mapped to null are leaving and are
   * neither notified nor re-queued.
   */
  private async endRoomLocked(
    room: Room,
    metricReason: MatchEndReason,
    reasons: Record<string, MatchEndReason | null>,
  ): Promise<void> {
    await this.store.deleteRoom(room.id);
    this.metrics.matchEndTotal.inc({ reason: metricReason });
    this.log.info({ roomId: room.id, reason: metricReason }, "room ended");
    const sessions = await this.store.getSessions(room.members);
    for (let i = 0; i < 2; i++) {
      const socketId = room.members[i]!;
      const reason = reasons[socketId] ?? null;
      if (!reason) continue;
      this.emitter.emit(socketId, "match:ended", { roomId: room.id, reason });
      const s = sessions[i];
      if (!s || s.roomId !== room.id) continue;
      const capped = await this.gate?.requeue(s.deviceId);
      if (capped || (await this.store.getBan(s.deviceId))) {
        s.state = "idle";
        s.roomId = undefined;
        s.waitingSince = undefined;
        await this.store.putSession(s);
        if (capped) this.emitter.emit(socketId, "server:error", { code: capped.error, message: capped.message });
      } else {
        await this.enqueueLocked(s);
      }
    }
  }

  /** Ends the session's room (partner gets partnerReason) and deletes the session. */
  private async removeSessionLocked(session: Session, partnerReason: MatchEndReason): Promise<void> {
    if (session.roomId) {
      const room = await this.store.getRoom(session.roomId);
      if (room && room.members.includes(session.socketId)) {
        const partner = room.members[0] === session.socketId ? room.members[1] : room.members[0];
        await this.endRoomLocked(room, partnerReason, { [session.socketId]: null, [partner]: partnerReason });
      }
    }
    await this.store.removeWaiting(session.socketId);
    await this.store.deleteSession(session.socketId);
    await this.store.clearDeviceSocket(session.deviceId, session.socketId);
  }

  /** The device connected again elsewhere: retire the old socket. */
  private async replaceLocked(oldSocketId: string): Promise<void> {
    this.emitter.emit(oldSocketId, "session:replaced");
    const old = await this.store.getSession(oldSocketId);
    if (old) await this.removeSessionLocked(old, "partner-unavailable");
    this.local.delete(oldSocketId);
    this.emitter.disconnect(oldSocketId);
  }

  /**
   * Blocks the room's device pair. A skip escalates: skipBlockMs times the
   * pair's skip count. Other blocks last `durationMs`. A block never shortens.
   */
  private async blockPairLocked(room: Room, durationMs: number, escalate: boolean): Promise<void> {
    const [a, b] = room.devices;
    const now = this.now();
    const existing = await this.store.getBlock(a, b);
    const skipCount = (existing?.skipCount ?? 0) + (escalate ? 1 : 0);
    const duration = escalate ? this.config.skipBlockMs * skipCount : durationMs;
    const until = Math.max(existing?.until ?? 0, now + duration);
    await this.store.setBlock(a, b, { until, skipCount }, until - now + BLOCK_MEMORY_MS);
  }

  /**
   * FIFO match pass: walk waiting sessions oldest first and pair each with
   * the oldest compatible, unblocked, unbanned waiting session after it.
   *
   * After an event only the sessions queued or changed since the last pass
   * ("dirty") can form new pairs, so the default pass only tries pairs that
   * include one of them: O(waiting x dirty) instead of O(waiting^2). It gives
   * the same pairs as a full pass, because the other waiters were already
   * unmatchable with each other. The sweeper runs the full pass.
   */
  private async matchPassLocked(full = false): Promise<void> {
    // Kill switch or outside staffed hours: keep the queue, match nobody.
    if (!this.flags.status(this.now()).open) return;
    const focus = full ? null : new Set(this.dirty);
    this.dirty.clear();
    if (focus && focus.size === 0) return;

    const ids = await this.store.listWaiting();
    if (ids.length < 2) return;
    const loaded = await this.store.getSessions(ids);
    const waiting: Session[] = [];
    for (let i = 0; i < ids.length; i++) {
      const s = loaded[i];
      if (s && s.state === "waiting") waiting.push(s);
      else await this.store.removeWaiting(ids[i]!); // stale entry
    }
    if (waiting.length < 2) return;

    const now = this.now();
    const banCache = new Map<string, boolean>();
    const isBanned = async (deviceId: string): Promise<boolean> => {
      let banned = banCache.get(deviceId);
      if (banned === undefined) {
        banned = (await this.store.getBan(deviceId)) !== null;
        banCache.set(deviceId, banned);
      }
      return banned;
    };
    const all = waiting.map((_, i) => i);
    const focused = focus ? all.filter((i) => focus.has(waiting[i]!.socketId)) : all;

    const taken = new Set<number>();
    for (let i = 0; i < waiting.length; i++) {
      if (taken.has(i)) continue;
      const a = waiting[i]!;
      // A non-dirty session can only pair with a dirty one.
      const partners = !focus || focus.has(a.socketId) ? all : focused;
      // Both lists are ascending; start after i.
      let k = partners === all ? i + 1 : 0;
      while (k < partners.length && partners[k]! <= i) k++;
      for (; k < partners.length; k++) {
        const j = partners[k]!;
        if (taken.has(j)) continue;
        const b = waiting[j]!;
        if (!isCompatible(a, b)) continue;
        if ((await isBanned(a.deviceId)) || (await isBanned(b.deviceId))) continue;
        const block = await this.store.getBlock(a.deviceId, b.deviceId);
        if (block && block.until > now) continue;
        taken.add(i);
        taken.add(j);
        await this.createRoomLocked(a, b, now);
        break;
      }
    }
  }

  private async createRoomLocked(a: Session, b: Session, now: number): Promise<void> {
    const room: Room = {
      id: randomUUID(),
      state: "pending",
      members: [a.socketId, b.socketId],
      devices: [a.deviceId, b.deviceId],
      accepted: [false, false],
      createdAt: now,
      expiresAt: now + this.config.matchAcceptTimeoutMs,
    };
    await this.store.putRoom(room);
    for (const s of [a, b]) {
      s.state = "pending";
      s.roomId = room.id;
      s.waitingSince = undefined;
      await this.store.putSession(s);
      await this.store.removeWaiting(s.socketId);
    }
    const [isFriend, photoA, photoB] = await Promise.all([
      this.store.areFriends(a.deviceId, b.deviceId),
      this.store.getPhoto(a.socketId),
      this.store.getPhoto(b.socketId),
    ]);
    this.metrics.matchesTotal.inc();
    this.log.info({ roomId: room.id }, "match found");
    if (this.gate) await Promise.all([this.gate.recordMatch(a.deviceId), this.gate.recordMatch(b.deviceId)]);
    const sharedTopics = a.profile.topics.filter((t) => b.profile.topics.includes(t));
    const base = { roomId: room.id, isFriend, expiresAt: room.expiresAt, serverNow: now, sharedTopics };
    this.emitter.emit(a.socketId, "match:found", { ...base, mode: a.mode, partner: publicProfile(b.profile, photoB) });
    this.emitter.emit(b.socketId, "match:found", { ...base, mode: b.mode, partner: publicProfile(a.profile, photoA) });
  }
}
