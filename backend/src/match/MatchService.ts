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
import type { BillingService } from "../billing/BillingService";
import type { Config } from "../config";
import type { EnforcementService, RestrictionSink } from "../enforcement/EnforcementService";
import { parseEvidenceFrame, type EvidenceFrame } from "../enforcement/evidence";
import type { FlagsReader } from "../flags/flags";
import type { Logger } from "../logger";
import type { Metrics } from "../metrics";
import type { QueueGate } from "../session/queueGate";
import type {
  CallFailedPayload,
  CallTelemetryPayload,
  ChatAck,
  ChatSendPayload,
  ChatTypingPayload,
  HelloAck,
  HelloPayload,
  MatchEndReason,
  MatchMode,
  ModerationSignalPayload,
  PublicProfile,
  ReportAck,
  ReportPayload,
  Restriction,
  RtcSignal,
  ServerToClientEvents,
  SimpleAck,
  UpdatePreferencesPayload,
} from "../protocol";
import type { MatchStore, Room, Session, SessionProfile } from "../store/MatchStore";
import { guardChat, guardName } from "../safety/guard";
import { NUDGE_RISK, type SafetySignals } from "../safety/signals";
import { ACCEPT_TIMEOUT_STRIKES } from "../safety/constants";
import type { TurnService } from "../turn/TurnService";
import { isCompatible } from "./compatibility";
import { HELD, MAX_STEP, meetsPreferences, pairStep, relaxStep } from "./relax";

/** How long a pair block record is remembered after it lapses, so repeated skips escalate. */
const BLOCK_MEMORY_MS = 24 * 60 * 60_000;
/** A permanent restriction is mirrored into the match store's ban with this horizon. */
const PERMANENT_BAN_MS = 100 * 365 * 24 * 60 * 60_000;

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
  /** Per-call ICE servers and media caps. */
  turn: TurnService;
  /** Risk score, early skips, low priority, nudge cooldowns. */
  safety: SafetySignals;
  /** Reports, restrictions and appeals. Optional so a bare service can be built in tests. */
  enforcement?: EnforcementService;
  /** Coin balance, earned coins and premium entitlements (gender filter). */
  billing: Pick<BillingService, "balance" | "earn" | "mayUseGenderFilter" | "walletView">;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Per-socket bookkeeping for sockets owned by this instance. */
interface LocalSocket {
  deviceId: string;
  /** Set when a sweep found no stored session for this socket (see tickRewards). */
  orphaned?: boolean;
  /** Rooms this socket already sent call:telemetry for (last 20). */
  telemetryRooms?: string[];
  rewards?: {
    roomId: string;
    connectedSince: number;
    partnerDevice: string;
    intervalsAwarded: number;
    friended: boolean;
  };
}

export function publicProfile(profile: SessionProfile, photo: string | null): PublicProfile {
  const { gender: _gender, ...rest } = profile;
  return photo ? { ...rest, photo } : rest;
}

/** The device the reporter can report: from the live room or the room that ended moments ago. */
interface ReportTarget {
  reportedDevice: string;
  devices: [string, string];
  activeSince: number | null;
  endedAt: number | null;
}

export class MatchService implements RestrictionSink {
  private readonly store: MatchStore;
  private readonly enforcement?: EnforcementService;
  private readonly billing: MatchServiceDeps["billing"];
  private readonly config: Config;
  private readonly log: Logger;
  private readonly metrics: Metrics;
  private readonly emitter: Emitter;
  private readonly flags: FlagsReader;
  private readonly gate?: QueueGate;
  private readonly turn: TurnService;
  private readonly safety: SafetySignals;
  private readonly now: () => number;
  private readonly local = new Map<string, LocalSocket>();
  /**
   * Relaxation ladder progress of sessions THIS instance queued: the sweeper
   * marks a session dirty when its step goes up (so the incremental pass
   * retries it) and tells it with queue:waiting. Entries leave at the last step.
   */
  private readonly relaxing = new Map<string, { since: number; step: number; low: boolean }>();
  /** Real number of sessions, refreshed by the sweeper (queue:waiting `online`). */
  private online = 0;
  private lastOnlineAt = 0;
  /** Sessions queued or changed since the last match pass (only touched under the lock). */
  private readonly dirty = new Set<string>();
  /**
   * Waiting sessions a block kept from a compatible partner, with the time
   * that block lapses. The sweeper marks them dirty then (only touched under the lock).
   */
  private readonly wakeAt = new Map<string, number>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private started?: Promise<void>;
  private sweeping?: Promise<void>;
  private stopped = false;
  private lastRecheckAt = 0;
  /** Where the next recheck slice starts in the waiting queue. */
  private recheckCursor = 0;
  private lastReapAt = 0;

  constructor(deps: MatchServiceDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.log = deps.logger;
    this.metrics = deps.metrics;
    this.emitter = deps.emitter;
    this.flags = deps.flags;
    this.gate = deps.gate;
    this.turn = deps.turn;
    this.safety = deps.safety;
    this.now = deps.now ?? Date.now;
    this.enforcement = deps.enforcement;
    this.billing = deps.billing;
    this.enforcement?.setSink(this);
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
   * sessions so partners on other instances are re-queued and matched.
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
      // Match the re-queued partners now: other instances never see this
      // instance's dirty marks, so they would wait for a recheck slice.
      await this.matchPassLocked();
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
  async hello(socketId: string, payload: HelloPayload, reply: Reply<HelloAck>, ip?: string): Promise<void> {
    if (this.stopped) return reply({ ok: false, error: "internal", message: "server shutting down" });
    const { deviceId } = payload;
    if (this.enforcement) {
      const restriction = await this.enforcement.activeForDevice(deviceId);
      if (restriction) return reply({ ok: false, error: "banned", restriction });
    }
    if (await this.store.getBan(deviceId)) return reply({ ok: false, error: "banned" });
    if (ip) {
      await this.turn.rememberIp(deviceId, ip).catch((err: unknown) => this.log.warn({ err }, "remember ip failed"));
    }
    await this.enforcement?.noteDeviceSeen(deviceId);
    // An expired unlock (or an old bundle) must not strand the client: the
    // filter is downgraded to "all" and the ack says so. Only session:preferences refuses.
    const preferences =
      payload.preferences.genderFilter !== "all" && !(await this.billing.mayUseGenderFilter(deviceId))
        ? { ...payload.preferences, genderFilter: "all" as const }
        : payload.preferences;

    await this.store.withLock(async () => {
      // The socket may have disconnected while we waited for the lock.
      if (!this.emitter.isLocalConnected(socketId)) return reply({ ok: false, error: "bad_state" });
      const now = this.now();
      const { photo, ...profile } = payload.profile;
      const name = guardName(profile.name, deviceId);
      if (name.replaced) {
        profile.name = name.name;
        this.metrics.namesReplacedTotal.inc();
      }
      let session = await this.store.getSession(socketId);

      if (session && session.deviceId !== deviceId) {
        return reply({ ok: false, error: "bad_state", message: "deviceId cannot change on a live socket" });
      }
      // Gate only hellos that would join the queue; a re-hello mid-call just updates the profile.
      if (!session || session.state === "idle") {
        const cooldownMs = await this.safety.acceptCooldownMs(deviceId);
        if (cooldownMs > 0) {
          return reply({
            ok: false,
            error: "rate_limited",
            message: `You let ${ACCEPT_TIMEOUT_STRIKES} matches expire. You can search again in ${Math.ceil(cooldownMs / 1000)} s.`,
          });
        }
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
          preferences,
          mode: payload.mode,
          state: "idle",
          connectedAt: now,
        };
        await this.store.setDeviceSocket(deviceId, socketId);
      } else {
        session.profile = profile;
        session.preferences = preferences;
        session.mode = payload.mode;
      }
      await this.store.putSession(session);
      await this.store.setPhoto(socketId, photo ?? null);
      this.local.set(socketId, this.local.get(socketId) ?? { deviceId });

      const coins = await this.billing.balance(deviceId);
      reply({ ok: true, coins, iceServers: this.turn.stunServers(), mode: this.effectiveMode(payload.mode), genderFilter: preferences.genderFilter });
      this.emitter.emit(socketId, "wallet:update", await this.billing.walletView(deviceId));

      if (session.state === "idle" || session.state === "waiting") {
        await this.enqueueLocked(session, session.state === "waiting" ? session.waitingSince : undefined);
        await this.matchPassLocked();
      }
    });
  }

  /**
   * session:preferences. An unchanged preference set is acknowledged without
   * touching the queue: a match pass loads every waiting session, and the
   * event may arrive once a second per socket.
   */
  async updatePreferences(socketId: string, payload: UpdatePreferencesPayload, reply: Reply<SimpleAck>): Promise<void> {
    await this.store.withLock(async () => {
      const session = await this.store.getSession(socketId);
      if (!session) return reply({ ok: false, error: "bad_state", message: "send session:hello first" });
      const { preferences } = payload;
      if (preferences.genderFilter !== "all" && !(await this.billing.mayUseGenderFilter(session.deviceId))) {
        return reply({ ok: false, error: "premium_required", message: "unlock the gender filter to use it" });
      }
      const same =
        session.preferences.genderFilter === preferences.genderFilter &&
        session.preferences.languageFilter === preferences.languageFilter;
      if (same) return reply({ ok: true });
      session.preferences = preferences;
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
      if (this.now() > room.expiresAt + this.config.matchAcceptGraceMs) {
        // Too late. Say so instead of dropping it; the sweeper ends the room.
        this.emitter.emit(socketId, "server:error", { code: "not_in_room", message: "the match expired" });
        return;
      }
      if (room.accepted[index]) return;
      room.accepted[index] = true;
      const other = room.members[1 - index]!;

      if (!room.accepted[0] || !room.accepted[1]) {
        await this.store.putRoom(room);
        this.emitter.emit(other, "match:partner-accepted", { roomId });
        return;
      }

      await this.activateRoomLocked(room);
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

  /**
   * call:connected. Rewards start once both members say their peer
   * connection is up, so a call whose media never connects earns nothing.
   */
  async connected(socketId: string, roomId: string): Promise<void> {
    await this.store.withLock(async () => {
      const found = await this.memberRoomLocked(socketId, roomId);
      if (!found || found.room.state !== "active") return;
      const { room, index } = found;
      const connected = room.connected ?? [false, false];
      if (connected[index]) return;
      connected[index] = true;
      room.connected = connected;
      if (connected[0] && connected[1]) room.connectedSince = this.now();
      await this.store.putRoom(room);
    });
  }

  /** call:skip ends the caller's pending or active room. */
  /** With roomId, a skip for a room the sender already left is ignored (late or repeated clicks). */
  async skip(socketId: string, roomId?: string): Promise<void> {
    await this.store.withLock(async () => {
      const session = await this.store.getSession(socketId);
      if (!session?.roomId) return;
      if (roomId && roomId !== session.roomId) return;
      const found = await this.memberRoomLocked(socketId, session.roomId);
      if (!found) return;
      const { room, index } = found;
      if (room.state === "active" && room.activeSince !== undefined) {
        this.safety.skipped(room.devices[1 - index]!, this.now() - room.activeSince);
      }
      await this.blockPairLocked(room, 0, true);
      await this.endRoomLocked(room, "skipped", {
        [room.members[index]]: "skipped",
        [room.members[1 - index]!]: "partner-skipped",
      });
      await this.matchPassLocked();
    });
  }

  /**
   * report:submit. Allowed while the room exists or within reportAfterEndMs after
   * it ended, once per room per reporter, and rate limited per device and per
   * client IP (see EnforcementService.admitReport). A live call ends; the pair is
   * blocked. The evidence and any automatic action are handled outside the match lock.
   */
  async report(socketId: string, payload: ReportPayload, reply: Reply<ReportAck>, ip: string | null = null): Promise<void> {
    const session = await this.store.getSession(socketId);
    if (!session) return reply({ ok: false, error: "bad_state", message: "send session:hello first" });
    let frame: EvidenceFrame | null = null;
    if (payload.evidence?.frame) {
      frame = parseEvidenceFrame(payload.evidence.frame);
      if (!frame) return reply({ ok: false, error: "invalid_payload", message: "evidence frame must be a JPEG" });
    }
    const target = await this.reportTarget(session, payload.roomId);
    if (!target) return reply({ ok: false, error: "not_in_room" });
    if (this.enforcement) {
      const admitted = await this.enforcement.admitReport(session.deviceId, payload.roomId, ip);
      if (admitted === "rate_limited") return reply({ ok: false, error: "rate_limited" });
      if (admitted === "duplicate") return reply({ ok: false, error: "bad_state", message: "already reported" });
    }

    await this.store.withLock(async () => {
      const found = await this.memberRoomLocked(socketId, payload.roomId);
      if (!found) {
        await this.blockPairLocked(target, this.config.reportBlockMs, false);
        return;
      }
      const { room, index } = found;
      await this.blockPairLocked(room, this.config.reportBlockMs, false);
      // The reported side only learns that the partner moved on.
      await this.endRoomLocked(room, "reported", {
        [socketId]: "reported",
        [room.members[1 - index]!]: "partner-skipped",
      });
      await this.matchPassLocked();
    });

    if (!this.enforcement) return reply({ ok: true, reportId: randomUUID() });
    const { reportId } = await this.enforcement.submitReport({
      roomId: payload.roomId,
      reporterDevice: session.deviceId,
      reporterIp: ip,
      reportedDevice: target.reportedDevice,
      reason: payload.reason,
      details: payload.details,
      frame,
      chat: payload.evidence?.chat,
      activeSince: target.activeSince,
      endedAt: target.endedAt,
    });
    reply({ ok: true, reportId });
  }

  private async reportTarget(session: Session, roomId: string): Promise<ReportTarget | null> {
    if (session.roomId === roomId) {
      const room = await this.store.getRoom(roomId);
      const index = room ? room.members.indexOf(session.socketId) : -1;
      if (room && index >= 0) {
        return {
          reportedDevice: room.devices[1 - index]!,
          devices: room.devices,
          activeSince: room.state === "active" ? (room.activeSince ?? null) : null,
          endedAt: null,
        };
      }
    }
    const last = await this.enforcement?.lastRoom(roomId);
    if (!last) return null;
    const index = last.devices.indexOf(session.deviceId);
    if (index < 0 || this.now() - last.endedAt > this.config.reportAfterEndMs) return null;
    return {
      reportedDevice: last.devices[1 - index]!,
      devices: last.devices,
      activeSince: last.activeSince,
      endedAt: last.endedAt,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Restrictions (called by EnforcementService)                       */
  /* ---------------------------------------------------------------- */

  /**
   * A pause or ban is mirrored into the match store's ban (match passes skip the
   * device and it is never re-queued), any room of the device ends with
   * "restricted" for it, and the device gets session:restricted. A warning is
   * only announced.
   */
  async restrictionApplied(deviceId: string, restriction: Restriction): Promise<void> {
    const blocking = restriction.kind !== "warning";
    if (blocking) await this.store.setBan(deviceId, restriction.until ?? this.now() + PERMANENT_BAN_MS);
    await this.store.withLock(async () => {
      const socketId = await this.store.getDeviceSocket(deviceId);
      const session = socketId ? await this.store.getSession(socketId) : null;
      if (!socketId || !session) return;
      if (blocking) {
        if (session.roomId) {
          const room = await this.store.getRoom(session.roomId);
          if (room && room.members.includes(socketId)) {
            const partner = room.members[0] === socketId ? room.members[1] : room.members[0];
            await this.endRoomLocked(room, "restricted", { [socketId]: "restricted", [partner]: "partner-skipped" });
          }
        }
        const fresh = await this.store.getSession(socketId);
        if (fresh && fresh.state !== "idle") {
          fresh.state = "idle";
          fresh.roomId = undefined;
          fresh.waitingSince = undefined;
          await this.store.putSession(fresh);
        }
        await this.store.removeWaiting(socketId);
      }
      this.emitter.emit(socketId, "session:restricted", { restriction });
      await this.matchPassLocked();
    });
  }

  /** Re-mirrors the ban after a restriction was lifted early (appeal overturned, report dismissed). */
  async restrictionLifted(deviceId: string, remaining: Restriction | null): Promise<void> {
    const until = remaining && remaining.kind !== "warning" ? (remaining.until ?? this.now() + PERMANENT_BAN_MS) : 0;
    await this.store.setBan(deviceId, until);
  }

  /** rtc:signal is relayed, unchanged, only to the other member of the sender's ACTIVE room. */
  async signal(socketId: string, payload: RtcSignal): Promise<void> {
    const partner = await this.activePartner(socketId, payload.roomId);
    if (partner) this.emitter.emit(partner, "rtc:signal", payload);
  }

  /**
   * chat:send. The safety guard hides links, handles and phone numbers during
   * the first chatGuardMs of the call and raises informative nudges.
   */
  async chat(socketId: string, payload: ChatSendPayload, reply: Reply<ChatAck>): Promise<void> {
    const active = await this.activeRoom(socketId, payload.roomId);
    if (!active) return reply({ ok: false, error: "not_in_room" });
    const { room, index } = active;
    const partner = room.members[1 - index]!;
    const roomId = payload.roomId;
    const id = randomUUID();
    const ts = this.now();
    const guarded = guardChat(payload.text, { redact: ts - (room.activeSince ?? ts) < this.config.chatGuardMs });
    this.emitter.emit(partner, "chat:message", { roomId, id, text: guarded.text, ts, redacted: guarded.redacted });
    reply({ ok: true, id, ts, redacted: guarded.redacted });

    if (guarded.redacted) {
      this.metrics.chatRedactedTotal.inc();
      if (this.safety.shouldNudge(`${roomId}:${socketId}`, "link-hidden")) {
        this.metrics.safetyNudgesTotal.inc({ kind: "link-hidden" });
        this.emitter.emit(socketId, "safety:nudge", { roomId, kind: "link-hidden" });
      }
    }
    for (const kind of ["contact-sharing", "solicitation"] as const) {
      if (kind === "contact-sharing" ? !guarded.contactSharing : !guarded.solicitation) continue;
      if (!this.safety.shouldNudge(roomId, kind)) continue;
      this.safety.addRisk(room.devices[index], NUDGE_RISK[kind], kind);
      this.metrics.safetyNudgesTotal.inc({ kind });
      this.emitter.emit(socketId, "safety:nudge", { roomId, kind });
      this.emitter.emit(partner, "safety:nudge", { roomId, kind });
    }
  }

  /**
   * call:failed: the WebRTC connection could not be established. Only a member
   * of the ACTIVE room may send it. Ends the room for both with
   * "connection-failed" and re-queues both; the pair is kept apart briefly so
   * they are not matched straight back into the same failing connection.
   */
  async callFailed(socketId: string, payload: CallFailedPayload): Promise<void> {
    await this.store.withLock(async () => {
      const found = await this.memberRoomLocked(socketId, payload.roomId);
      if (!found || found.room.state !== "active") return;
      const { room } = found;
      this.metrics.callFailedTotal.inc({ reason: payload.reason });
      await this.blockPairLocked(room, this.config.declineBlockMs, false);
      await this.endRoomLocked(room, "connection-failed", {
        [room.members[0]]: "connection-failed",
        [room.members[1]]: "connection-failed",
      });
      await this.matchPassLocked();
    });
  }

  /**
   * call:telemetry: counters only, once per socket and room. No IPs, no
   * content; the room may already have ended (it is sent at call end).
   */
  async telemetry(socketId: string, payload: CallTelemetryPayload): Promise<void> {
    const entry = this.local.get(socketId);
    if (!entry) return;
    entry.telemetryRooms ??= [];
    if (entry.telemetryRooms.includes(payload.roomId)) return;
    entry.telemetryRooms.push(payload.roomId);
    if (entry.telemetryRooms.length > 20) entry.telemetryRooms.shift();
    this.metrics.callsTotal.inc({
      outcome: payload.outcome,
      local_candidate: payload.localCandidateType ?? "unknown",
      private: payload.privateMode ? "true" : "false",
    });
    if (payload.outcome === "connected" && payload.timeToConnectMs !== undefined) {
      this.metrics.timeToConnectSeconds.observe(payload.timeToConnectMs / 1000);
    }
  }

  /** moderation:signal: counted per kind; feeds the soft risk score. */
  async moderationSignal(socketId: string, payload: ModerationSignalPayload): Promise<void> {
    const session = await this.store.getSession(socketId);
    if (!session || session.roomId !== payload.roomId) return;
    const room = await this.store.getRoom(payload.roomId);
    const index = room ? room.members.indexOf(socketId) : -1;
    const partner = room && index >= 0 ? room.devices[1 - index]! : null;
    this.safety.moderationSignal(socketId, payload.roomId, payload.kind, session.deviceId, partner);
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
      this.wakeAt.delete(socketId);
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
   * Removes the sessions of dead instances and this instance's sessions
   * whose socket is gone, expires pending rooms, runs a
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
          await this.removeGhostSessionsLocked();
        }
        const expired = await this.store.listExpiredPendingRooms(now - this.config.matchAcceptGraceMs);
        for (const roomId of expired) {
          const room = await this.store.getRoom(roomId);
          if (!room || room.state !== "pending") continue;
          await this.blockPairLocked(room, this.config.declineBlockMs, false);
          // Whoever accepted waited on the other and searches again; whoever
          // never pressed Accept goes idle, is told so, and gets a strike.
          for (let i = 0; i < 2; i++) if (!room.accepted[i]) this.safety.acceptTimedOut(room.devices[i]!);
          await this.endRoomLocked(room, "timeout", {
            [room.members[0]]: room.accepted[0] ? "timeout" : "accept-timeout",
            [room.members[1]]: room.accepted[1] ? "timeout" : "accept-timeout",
          });
        }
        // A block that kept a pair apart has lapsed: try those sessions again.
        for (const [socketId, until] of this.wakeAt) {
          if (until > now) continue;
          this.wakeAt.delete(socketId);
          this.dirty.add(socketId);
        }
        // Now and then also recheck a bounded slice of the queue, for marks
        // this instance never saw (sessions queued elsewhere, blocks changed).
        const recheck = now - this.lastRecheckAt >= this.config.recheckIntervalMs;
        if (recheck) this.lastRecheckAt = now;
        await this.relaxTickLocked(now);
        await this.matchPassLocked(recheck ? "recheck" : "dirty");
      });
      await this.tickRewards();
      const now = this.now();
      if (now - this.lastOnlineAt >= this.config.heartbeatIntervalMs) {
        this.lastOnlineAt = now;
        this.online = (await this.store.stats()).sessions;
      }
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

  /**
   * Removes this instance's sessions whose socket is gone. disconnect() is
   * normally what removes them, but if its cleanup fails (a Redis blip, a
   * lock wait timeout) nothing retries it, and the leftover session would be
   * matched with real users over and over. Safe against hello: a session is
   * only created under the lock after hello saw its socket connected.
   */
  private async removeGhostSessionsLocked(): Promise<void> {
    for (const socketId of await this.store.listInstanceSessions(this.config.instanceId)) {
      if (this.emitter.isLocalConnected(socketId)) continue;
      const session = await this.store.getSession(socketId);
      this.local.delete(socketId);
      this.wakeAt.delete(socketId);
      if (!session) continue;
      await this.removeSessionLocked(session, "partner-left");
      this.log.warn({ socketId }, "removed a session whose socket is gone");
    }
  }

  /** Runs one full O(waiting^2) match pass under the lock (exposed for tests; the sweeper never does this). */
  matchPass(): Promise<void> {
    return this.store.withLock(() => this.matchPassLocked("full"));
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
        // Nothing is earned until both peer connections are up (call:connected).
        if (!room || room.state !== "active" || room.connectedSince === undefined) continue;
        const index = room.members.indexOf(socketId);
        if (index < 0) continue;
        entry.rewards = {
          roomId: room.id,
          connectedSince: room.connectedSince,
          partnerDevice: room.devices[1 - index]!,
          intervalsAwarded: 0,
          friended: false,
        };
      }
      const r = entry.rewards;
      const elapsed = now - r.connectedSince;
      const due = Math.floor(elapsed / this.config.coinIntervalMs);
      if (due > r.intervalsAwarded) {
        const delta = (due - r.intervalsAwarded) * this.config.coinsPerInterval;
        r.intervalsAwarded = due;
        const balance = await this.billing.earn(session.deviceId, delta, r.roomId);
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
    const found = await this.activeRoom(socketId, roomId);
    return found ? found.room.members[1 - found.index]! : null;
  }

  private async activeRoom(socketId: string, roomId: string): Promise<{ room: Room; index: 0 | 1 } | null> {
    const session = await this.store.getSession(socketId);
    if (!session || session.state !== "active" || session.roomId !== roomId) return null;
    const room = await this.store.getRoom(roomId);
    if (!room || room.state !== "active") return null;
    const index = room.members.indexOf(socketId);
    return index < 0 ? null : { room, index: index as 0 | 1 };
  }

  /** The mode the server uses for a session: the default_mode flag can force preview. */
  private effectiveMode(requested: MatchMode): MatchMode {
    return this.flags.current().default_mode === "preview" ? "preview" : requested;
  }

  /**
   * Both sides accepted (or the server accepted for instant-mode sides): mark
   * the room and sessions active. call:start goes out from startCall, which
   * fetches per-call TURN credentials outside the lock.
   */
  private async activateRoomLocked(room: Room): Promise<void> {
    room.state = "active";
    room.activeSince = this.now();
    await this.store.putRoom(room);
    const sessions = await this.store.getSessions(room.members);
    for (const s of sessions) {
      if (s && s.roomId === room.id) {
        s.state = "active";
        await this.store.putSession(s);
      }
    }
    this.safety.callStarted(room.devices);
    this.log.info({ roomId: room.id }, "call started");
    // Not awaited: it takes the lock again after the network calls.
    void this.startCall(room);
  }

  /**
   * Per-call ICE servers (TURN credentials may need an API call) are fetched
   * without holding the matchmaking lock; call:start is then emitted under the
   * lock only if the room is still active, so it never follows match:ended.
   */
  private async startCall(room: Room): Promise<void> {
    try {
      const [mediaA, mediaB] = await Promise.all(room.devices.map((d) => this.turn.callMedia(d)));
      if (this.stopped) return;
      await this.store.withLock(async () => {
        const current = await this.store.getRoom(room.id);
        if (!current || current.state !== "active" || current.activeSince !== room.activeSince) return;
        this.emitter.emit(room.members[0], "call:start", { roomId: room.id, initiator: true, ...mediaA! });
        this.emitter.emit(room.members[1], "call:start", { roomId: room.id, initiator: false, ...mediaB! });
      });
    } catch (err) {
      this.log.error({ err, roomId: room.id }, "call start failed");
    }
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

  /**
   * Puts a session in the queue. The gender filter is re-checked here, on
   * every (re)queue, so an unlock that lapsed mid-session stops applying at
   * the next call rather than living as long as the socket.
   */
  private async enqueueLocked(session: Session, since?: number): Promise<void> {
    if (session.preferences.genderFilter !== "all" && !(await this.billing.mayUseGenderFilter(session.deviceId))) {
      session.preferences = { ...session.preferences, genderFilter: "all" };
      this.emitter.emit(session.socketId, "server:error", { code: "premium_required", message: "the gender filter unlock has expired" });
      this.emitter.emit(session.socketId, "wallet:update", await this.billing.walletView(session.deviceId));
    }
    session.state = "waiting";
    session.roomId = undefined;
    session.waitingSince = since ?? this.now();
    await this.store.putSession(session);
    await this.store.addWaiting(session.socketId, session.waitingSince);
    this.dirty.add(session.socketId);
    const low = (await this.safety.lowPriority()).has(session.deviceId);
    this.relaxing.set(session.socketId, { since: session.waitingSince, step: low ? HELD : 0, low });
    this.emitter.emit(session.socketId, "queue:waiting", this.waitingPayload(0));
  }

  private waitingPayload(step: number): { relaxStep: number; online?: number } {
    const relaxStep = Math.max(0, step);
    return this.online >= this.flags.current().online_count_threshold ? { relaxStep, online: this.online } : { relaxStep };
  }

  /**
   * Sweeper: sessions this instance queued whose ladder step went up are
   * marked dirty (the next incremental pass retries them) and told their new
   * step. A low-priority device is held back first, silently: it sees step 0.
   */
  private async relaxTickLocked(now: number): Promise<void> {
    const changed = new Map<string, number>();
    for (const [socketId, entry] of this.relaxing) {
      const step = relaxStep(now - entry.since, this.config, entry.low);
      if (step > entry.step) changed.set(socketId, step);
    }
    if (changed.size === 0) return;
    const ids = [...changed.keys()];
    const sessions = await this.store.getSessions(ids);
    for (let i = 0; i < ids.length; i++) {
      const socketId = ids[i]!;
      const entry = this.relaxing.get(socketId)!;
      const s = sessions[i];
      if (!s || s.state !== "waiting" || s.waitingSince !== entry.since) {
        this.relaxing.delete(socketId); // matched, gone or re-queued by another instance
        continue;
      }
      const step = changed.get(socketId)!;
      const shownBefore = Math.max(0, entry.step);
      entry.step = step;
      this.dirty.add(socketId);
      if (step > shownBefore) this.emitter.emit(socketId, "queue:waiting", this.waitingPayload(step));
      if (step >= MAX_STEP) this.relaxing.delete(socketId);
    }
  }

  /**
   * Deletes a room and tells each member why. Members with a reason are
   * re-queued (unless banned, or the reason is accept-timeout, which leaves
   * them idle); members mapped to null are leaving and are neither notified
   * nor re-queued.
   */
  private async endRoomLocked(
    room: Room,
    metricReason: MatchEndReason,
    reasons: Record<string, MatchEndReason | null>,
  ): Promise<void> {
    await this.store.deleteRoom(room.id);
    await this.noteRoomEnded(room);
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
      const idle = reason === "accept-timeout";
      const capped = idle ? undefined : await this.gate?.requeue(s.deviceId);
      if (idle || capped || (await this.store.getBan(s.deviceId))) {
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

  /** Lets enforcement accept late reports and count completed calls. Never fails the caller. */
  private async noteRoomEnded(room: Room): Promise<void> {
    if (!this.enforcement) return;
    try {
      await this.enforcement.roomEnded({
        roomId: room.id,
        devices: room.devices,
        activeSince: room.state === "active" ? (room.activeSince ?? null) : null,
        endedAt: this.now(),
      });
    } catch (err) {
      this.log.warn({ err, roomId: room.id }, "could not record the ended room");
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
    this.relaxing.delete(session.socketId);
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
  private async blockPairLocked(room: Pick<Room, "devices">, durationMs: number, escalate: boolean): Promise<void> {
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
   * unmatchable with each other, except across a block that has since lapsed
   * (wakeAt marks those sessions dirty again).
   *
   * "recheck" (sweeper) also focuses a bounded slice of the queue, so each
   * waiter is rechecked now and then without ever scanning all pairs. "full"
   * focuses everyone and is O(waiting^2); only tests use it.
   */
  private async matchPassLocked(mode: "dirty" | "recheck" | "full" = "dirty"): Promise<void> {
    // Kill switch or outside staffed hours: keep the queue, match nobody.
    if (!this.flags.status(this.now()).open) return;
    const focus = mode === "full" ? null : new Set(this.dirty);
    this.dirty.clear();
    if (focus && focus.size === 0 && mode === "dirty") return;

    const ids = await this.store.listWaiting();
    if (ids.length < 2) return;
    const loaded = await this.store.getSessions(ids);
    const waiting: Session[] = [];
    for (let i = 0; i < ids.length; i++) {
      const s = loaded[i];
      if (s && s.state === "waiting") waiting.push(s);
      else await this.store.removeWaiting(ids[i]!); // stale entry
    }
    if (mode === "recheck") {
      // Forget lapse times of sessions that left the queue (possibly on another instance).
      const queued = new Set(waiting.map((s) => s.socketId));
      for (const socketId of this.wakeAt.keys()) if (!queued.has(socketId)) this.wakeAt.delete(socketId);
    }
    if (waiting.length < 2) return;
    if (focus && mode === "recheck") this.addRecheckSlice(waiting, focus);
    if (focus && focus.size === 0) return;

    const now = this.now();
    const low = await this.safety.lowPriority();
    const steps = waiting.map((s) => relaxStep(now - (s.waitingSince ?? now), this.config, low.has(s.deviceId)));
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
      if (taken.has(i) || steps[i] === HELD) continue;
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
        const step = pairStep(steps[i]!, steps[j]!);
        if (step === HELD || !isCompatible(a, b) || !meetsPreferences(a, b, step)) continue;
        if ((await isBanned(a.deviceId)) || (await isBanned(b.deviceId))) continue;
        const block = await this.store.getBlock(a.deviceId, b.deviceId);
        if (block && block.until > now) {
          const wake = this.wakeAt.get(a.socketId);
          if (wake === undefined || block.until < wake) this.wakeAt.set(a.socketId, block.until);
          continue;
        }
        taken.add(i);
        taken.add(j);
        await this.createRoomLocked(a, b, now);
        break;
      }
    }
  }

  /**
   * Adds the next slice of the queue to `focus`, sized so the pass costs
   * about recheckPairBudget pair checks. The cursor is a plain index into
   * the queue, so a queue that changes between rechecks may make it skip or
   * repeat a few sessions; the next round covers them.
   */
  private addRecheckSlice(waiting: Session[], focus: Set<string>): void {
    const count = Math.max(1, Math.floor(this.config.recheckPairBudget / waiting.length));
    if (count >= waiting.length) {
      for (const s of waiting) focus.add(s.socketId);
      this.recheckCursor = 0;
      return;
    }
    const start = this.recheckCursor % waiting.length;
    for (let k = 0; k < count; k++) focus.add(waiting[(start + k) % waiting.length]!.socketId);
    this.recheckCursor = start + count;
  }

  /**
   * Creates a pending room and sends match:found. Instant-mode sides are
   * accepted by the server: instant + instant starts the call at once;
   * instant + preview shows the preview side its card while the instant side
   * waits for it (it sees match:found with mode "instant").
   */
  private async createRoomLocked(a: Session, b: Session, now: number): Promise<void> {
    const modes = [this.effectiveMode(a.mode), this.effectiveMode(b.mode)] as const;
    const room: Room = {
      id: randomUUID(),
      state: "pending",
      members: [a.socketId, b.socketId],
      devices: [a.deviceId, b.deviceId],
      accepted: [modes[0] === "instant", modes[1] === "instant"],
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
      this.relaxing.delete(s.socketId);
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
    this.emitter.emit(a.socketId, "match:found", { ...base, mode: modes[0], partner: publicProfile(b.profile, photoB) });
    this.emitter.emit(b.socketId, "match:found", { ...base, mode: modes[1], partner: publicProfile(a.profile, photoA) });
    if (room.accepted[0] && room.accepted[1]) await this.activateRoomLocked(room);
    else if (room.accepted[0]) this.emitter.emit(b.socketId, "match:partner-accepted", { roomId: room.id });
    else if (room.accepted[1]) this.emitter.emit(a.socketId, "match:partner-accepted", { roomId: room.id });
  }
}
