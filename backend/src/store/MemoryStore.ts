/**
 * In-process MatchStore for a single instance (local dev and tests).
 * Values are deep-copied in and out so behavior matches a serializing store.
 */
import {
  REPORT_LOG_MAX,
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
  private readonly devices = new Map<string, string>();
  private readonly waiting = new Map<string, number>();
  private readonly rooms = new Map<string, Room>();
  private readonly coins = new Map<string, number>();
  private readonly friends = new Set<string>();
  private readonly blocks = new Map<string, { block: PairBlock; retainUntil: number }>();
  private readonly reports: ReportRecord[] = [];
  private readonly reportsAgainst = new Map<string, Map<string, number>>();
  private readonly bans = new Map<string, number>();
  private blockWrites = 0;
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
    this.waiting.delete(socketId);
    this.waiting.set(socketId, since);
  }

  async removeWaiting(socketId: string): Promise<void> {
    this.waiting.delete(socketId);
  }

  async listWaiting(): Promise<string[]> {
    // Array.prototype.sort is stable, so equal scores keep insertion order.
    return [...this.waiting.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  }

  async getRoom(roomId: string): Promise<Room | null> {
    const r = this.rooms.get(roomId);
    return r ? copy(r) : null;
  }

  async putRoom(room: Room): Promise<void> {
    this.rooms.set(room.id, copy(room));
  }

  async deleteRoom(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
  }

  async listExpiredPendingRooms(cutoff: number): Promise<string[]> {
    return [...this.rooms.values()]
      .filter((r) => r.state === "pending" && r.expiresAt <= cutoff)
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .map((r) => r.id);
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
    if (++this.blockWrites % 1000 === 0) {
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
    this.bans.set(deviceId, until);
  }

  async stats(): Promise<StoreStats> {
    let pendingRooms = 0;
    let activeRooms = 0;
    for (const r of this.rooms.values()) {
      if (r.state === "pending") pendingRooms++;
      else activeRooms++;
    }
    return { sessions: this.sessions.size, waiting: this.waiting.size, pendingRooms, activeRooms };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
