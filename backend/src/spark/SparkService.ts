/**
 * Spark: one icebreaker shown to both members of a room at the same moment.
 *
 * spark:request from an active member -> the server picks a prompt id that
 * fits the pair (prompts tagged with a topic both picked, else any) and that
 * none of the room's last SPARK.historySize prompts used -> spark:show goes to
 * both members. One prompt per room per SPARK.cooldownMs; the ack says
 * rate_limited meanwhile so the client can show the cooldown without a banner.
 *
 * Per-room state lives in memory on the instance that served the request.
 * With several instances a pair may hit two cooldown clocks, which only
 * means a slightly looser limit; the emit itself is cross-instance.
 */
import { Counter, type Registry } from "prom-client";
import type { Emitter, Reply } from "../match/MatchService";
import { SPARK, type SparkAck, type Topic } from "../protocol";
import { activeMember } from "../realtime/roomMembership";
import type { MatchStore } from "../store/MatchStore";
import { SPARK_PROMPTS, type SparkPrompt } from "./catalog";

export interface SparkServiceDeps {
  store: MatchStore;
  emitter: Emitter;
  registry: Registry;
  /** Prompts to pick from; defaults to the catalog. */
  prompts?: readonly SparkPrompt[];
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable [0, 1) source for tests. */
  random?: () => number;
}

interface RoomSpark {
  /** When the last prompt went out (epoch ms). */
  lastAt: number;
  /** Most recent prompt ids, oldest first, at most SPARK.historySize. */
  recent: string[];
}

/** Room entries idle this long are forgotten (a call never lasts that long without a prompt). */
const ROOM_IDLE_MS = 60 * 60_000;
const PRUNE_EVERY_MS = 60_000;

export class SparkService {
  private readonly store: MatchStore;
  private readonly emitter: Emitter;
  private readonly prompts: readonly SparkPrompt[];
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly rooms = new Map<string, RoomSpark>();
  private lastPrune: number;
  readonly sparkTotal: Counter;

  constructor(deps: SparkServiceDeps) {
    this.store = deps.store;
    this.emitter = deps.emitter;
    this.prompts = deps.prompts ?? SPARK_PROMPTS;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.lastPrune = this.now();
    this.sparkTotal = new Counter({
      name: "chizzy_spark_total",
      help: "Spark prompts shown (one per request that reached both members)",
      registers: [deps.registry],
    });
  }

  async request(socketId: string, roomId: string, reply: Reply<SparkAck>): Promise<void> {
    const member = await activeMember(this.store, socketId, roomId);
    if (!member) return reply({ ok: false, error: "not_in_room" });

    const now = this.now();
    this.prune(now);
    const known = this.rooms.get(roomId);
    if (known && now - known.lastAt < SPARK.cooldownMs) return reply({ ok: false, error: "rate_limited" });
    const state = known ?? { lastAt: now, recent: [] };

    const [a, b] = await this.store.getSessions(member.room.members);
    const shared = a && b ? a.profile.topics.filter((t) => b.profile.topics.includes(t)) : [];
    const promptId = this.pick(shared, state.recent);

    state.lastAt = now;
    state.recent.push(promptId);
    if (state.recent.length > SPARK.historySize) state.recent.splice(0, state.recent.length - SPARK.historySize);
    this.rooms.set(roomId, state);

    this.sparkTotal.inc();
    this.emitter.emit(socketId, "spark:show", { roomId, promptId, from: "you", at: now });
    this.emitter.emit(member.partner, "spark:show", { roomId, promptId, from: "partner", at: now });
    reply({ ok: true, promptId });
  }

  /**
   * Prompts tagged with a shared topic that the room has not seen lately;
   * then any unseen prompt; then (catalog exhausted) anything at all.
   */
  private pick(shared: readonly Topic[], recent: readonly string[]): string {
    const fresh = this.prompts.filter((p) => !recent.includes(p.id));
    const onTopic = shared.length > 0 ? fresh.filter((p) => p.topics.some((t) => shared.includes(t))) : [];
    const pool = onTopic.length > 0 ? onTopic : fresh.length > 0 ? fresh : this.prompts;
    return pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))]!.id;
  }

  private prune(now: number): void {
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    for (const [roomId, state] of this.rooms) if (now - state.lastAt >= ROOM_IDLE_MS) this.rooms.delete(roomId);
  }
}
