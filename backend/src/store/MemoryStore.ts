/**
 * In-process MatchStore for a single instance (local dev and tests).
 * Values are deep-copied in and out so behavior matches a serializing store.
 */
import { PRUNE_EVERY_WRITES, REPORTS_AGAINST_TTL_MS, REPORT_LOG_MAX } from "./constants";
import {
  pairKey,
  type MatchStore,
  type PairBlock,
  type ReportRecord,
  type Room,
  type Session,
  type StoreStats,
} from "./MatchStore";

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements MatchStore {
  private readonly sessions = new Map<string, Session>();
  private readonly photos = new Map<string, string>();
  private readonly devices = new Map<string, string>();
  /** The queue, oldest first; `waitingSince` is the position key. Kept sorted so a pass never sorts it. */
  private readonly waiting: { socketId: string; since: number }[] = [];
  private readonly waitingSince = new Map<string, number>();
  private readonly rooms = new Map<string, Room>();
  /** roomId -> expiresAt of every pending room, so the sweep's expiry scan skips active rooms. */
  private readonly pendingRooms = new Map<string, number>();
  private readonly coins = new Map<string, number>();
  private readonly friends = new Set<string>();
  private readonly blocks = new Map<string, { block: PairBlock; retainUntil: number }>();
  private readonly reports: ReportRecord[] = [];
  private readonly reportsAgainst = new Map<string, Map<string, number>>();
  private readonly bans = new Map<string, number>();
  /** instanceId -> heartbeat expiry (epoch ms). */
  private readonly instances = new Map<string, number>();
  private blockWrites = 0;
  private reportWrites = 0;
  private lockTail: Promise<void> = Promise.resolve();
  private closed = false;

  async ping(): Promise<void> {
    if (this.closed) throw new Error("store closed");
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async getSession(socketId: string): Promise<Session | null> {
    const s = this.sessions.get(socketId);
    return s ? copy(s) : null;
  }

  async getSessions(socketIds: string[]): Promise<(Session | null)[]> {
    return socketIds.map((id) => {
      const s = this.sessions.get(id);
      return s ? copy(s) : null;
    });
  }

  async putSession(session: Session): Promise<void> {
    this.sessions.set(session.socketId, copy(session));
  }

  async deleteSession(socketId: string): Promise<void> {
    this.sessions.delete(socketId);
    this.photos.delete(socketId);
  }

  async setPhoto(socketId: string, photo: string | null): Promise<void> {
    if (photo === null) this.photos.delete(socketId);
    else this.photos.set(socketId, photo);
  }

  async getPhoto(socketId: string): Promise<string | null> {
    return this.photos.get(socketId) ?? null;
  }

  async getDeviceSocket(deviceId: string): Promise<string | null> {
    return this.devices.get(deviceId) ?? null;
  }

  async setDeviceSocket(deviceId: string, socketId: string): Promise<void> {
    this.devices.set(deviceId, socketId);
  }

  async clearDeviceSocket(deviceId: string, socketId: string): Promise<void> {
    if (this.devices.get(deviceId) === socketId) this.devices.delete(deviceId);
  }

  async addWaiting(socketId: string, since: number): Promise<void> {
    this.removeFromQueue(socketId);
    // First index whose key is greater: equal keys keep arrival order.
    let lo = 0;
    let hi = this.waiting.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.waiting[mid]!.since <= since) lo = mid + 1;
      else hi = mid;
    }
    this.waiting.splice(lo, 0, { socketId, since });
    this.waitingSince.set(socketId, since);
  }

  async removeWaiting(socketId: string): Promise<void> {
    this.removeFromQueue(socketId);
  }

  private removeFromQueue(socketId: string): void {
    const since = this.waitingSince.get(socketId);
    if (since === undefined) return;
    this.waitingSince.delete(socketId);
    // Binary search to the first entry with this key, then scan the equal run.
    let lo = 0;
    let hi = this.waiting.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.waiting[mid]!.since < since) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.waiting.length && this.waiting[i]!.since === since; i++) {
      if (this.waiting[i]!.socketId === socketId) {
        this.waiting.splice(i, 1);
        return;
      }
    }
  }

  async listWaiting(): Promise<string[]> {
    return this.waiting.map((entry) => entry.socketId);
  }

  async getRoom(roomId: string): Promise<Room | null> {
    const r = this.rooms.get(roomId);
    return r ? copy(r) : null;
  }

  async putRoom(room: Room): Promise<void> {
    this.rooms.set(room.id, copy(room));
    if (room.state === "pending") this.pendingRooms.set(room.id, room.expiresAt);
    else this.pendingRooms.delete(room.id);
  }

  async deleteRoom(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
    this.pendingRooms.delete(roomId);
  }

  /** O(pending rooms) per sweep: at most half the waiting sessions, each only for the accept window. */
  async listExpiredPendingRooms(cutoff: number): Promise<string[]> {
    const expired: [string, number][] = [];
    for (const [id, expiresAt] of this.pendingRooms) if (expiresAt <= cutoff) expired.push([id, expiresAt]);
    return expired.sort((a, b) => a[1] - b[1]).map(([id]) => id);
  }

  async getCoins(deviceId: string): Promise<number | null> {
    return this.coins.get(deviceId) ?? null;
  }

  async addCoins(deviceId: string, delta: number, initial: number): Promise<number> {
    const balance = (this.coins.get(deviceId) ?? initial) + delta;
    this.coins.set(deviceId, balance);
    return balance;
  }

  async areFriends(deviceA: string, deviceB: string): Promise<boolean> {
    return this.friends.has(pairKey(deviceA, deviceB));
  }

  async addFriends(deviceA: string, deviceB: string): Promise<void> {
    this.friends.add(pairKey(deviceA, deviceB));
  }

  async getBlock(deviceA: string, deviceB: string): Promise<PairBlock | null> {
    const key = pairKey(deviceA, deviceB);
    const entry = this.blocks.get(key);
    if (!entry) return null;
    if (entry.retainUntil <= Date.now()) {
      this.blocks.delete(key);
      return null;
    }
    return copy(entry.block);
  }

  async setBlock(deviceA: string, deviceB: string, block: PairBlock, retainMs: number): Promise<void> {
    const now = Date.now();
    this.blocks.set(pairKey(deviceA, deviceB), { block: copy(block), retainUntil: now + retainMs });
    // Bound memory on long runs: drop expired blocks every so often.
    if (++this.blockWrites % PRUNE_EVERY_WRITES === 0) {
      for (const [key, entry] of this.blocks) if (entry.retainUntil <= now) this.blocks.delete(key);
    }
  }

  async addReport(report: ReportRecord): Promise<void> {
    this.reports.push(copy(report));
    if (this.reports.length > REPORT_LOG_MAX) this.reports.splice(0, this.reports.length - REPORT_LOG_MAX);
    let against = this.reportsAgainst.get(report.reportedDevice);
    if (!against) {
      against = new Map();
      this.reportsAgainst.set(report.reportedDevice, against);
    }
    against.set(report.reporterDevice, Math.max(against.get(report.reporterDevice) ?? 0, report.ts));
    // Same retention as the Redis index: a device's reporters are forgotten
    // REPORTS_AGAINST_TTL_MS after its last report (checked every so often).
    if (++this.reportWrites % PRUNE_EVERY_WRITES === 0) {
      const cutoff = Date.now() - REPORTS_AGAINST_TTL_MS;
      for (const [device, reporters] of this.reportsAgainst) {
        if (Math.max(...reporters.values()) < cutoff) this.reportsAgainst.delete(device);
      }
    }
  }

  async countReporters(deviceId: string, since: number): Promise<number> {
    const against = this.reportsAgainst.get(deviceId);
    if (!against) return 0;
    let count = 0;
    for (const [reporter, ts] of against) {
      if (ts >= since) count++;
      else against.delete(reporter);
    }
    if (against.size === 0) this.reportsAgainst.delete(deviceId);
    return count;
  }

  async getBan(deviceId: string): Promise<number | null> {
    const until = this.bans.get(deviceId);
    if (until === undefined) return null;
    if (until <= Date.now()) {
      this.bans.delete(deviceId);
      return null;
    }
    return until;
  }

  async setBan(deviceId: string, until: number): Promise<void> {
    if (until <= Date.now()) this.bans.delete(deviceId);
    else this.bans.set(deviceId, until);
  }

  async heartbeat(instanceId: string, ttlMs: number): Promise<void> {
    this.instances.set(instanceId, Date.now() + ttlMs);
  }

  async listDeadInstances(): Promise<string[]> {
    const now = Date.now();
    return [...this.instances].filter(([, expiry]) => expiry <= now).map(([id]) => id);
  }

  /**
   * O(sessions). The memory store is single-instance, so every session is
   * this instance's and the answer is the whole map; an index would not
   * shrink the sweep's work (removeGhostSessionsLocked visits each one).
   */
  async listInstanceSessions(instanceId: string): Promise<string[]> {
    return [...this.sessions.values()].filter((s) => s.instanceId === instanceId).map((s) => s.socketId);
  }

  async forgetInstance(instanceId: string): Promise<void> {
    this.instances.delete(instanceId);
  }

  async stats(): Promise<StoreStats> {
    let pendingRooms = 0;
    let activeRooms = 0;
    for (const r of this.rooms.values()) {
      if (r.state === "pending") pendingRooms++;
      else activeRooms++;
    }
    return { sessions: this.sessions.size, waiting: this.waiting.length, pendingRooms, activeRooms };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
