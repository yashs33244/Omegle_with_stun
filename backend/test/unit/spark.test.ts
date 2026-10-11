/**
 * SparkService picking rules and the catalog's content invariants.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Registry } from "prom-client";
import type { Emitter } from "../../src/match/MatchService";
import { SPARK, TOPICS, type SparkAck, type Topic } from "../../src/protocol";
import { SPARK_PROMPTS } from "../../src/spark/catalog";
import { PROMPT_LANGS, promptFile } from "../../src/spark/promptFile";
import { SparkService } from "../../src/spark/SparkService";
import { MemoryStore } from "../../src/store/MemoryStore";
import type { Room, Session } from "../../src/store/MatchStore";
import { prefs, profile } from "../helpers";

type Emitted = { socketId: string; event: string; payload: unknown };

function fakeEmitter(): Emitter & { emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  return {
    emitted,
    emit(socketId, event, ...args) {
      emitted.push({ socketId, event, payload: args[0] });
    },
    disconnect() {},
    isLocalConnected: () => true,
  };
}

function session(socketId: string, topics: Topic[], state: Session["state"] = "active", roomId?: string): Session {
  return {
    socketId,
    deviceId: `dev-${socketId}`,
    instanceId: "test",
    profile: profile({ topics }),
    preferences: prefs(),
    mode: "instant",
    state,
    roomId,
    connectedAt: 0,
  };
}

/** Two active members in one active room. */
async function activeRoom(store: MemoryStore, topicsA: Topic[], topicsB: Topic[]) {
  const roomId = randomUUID();
  const a = `a-${roomId}`;
  const b = `b-${roomId}`;
  await store.putSession(session(a, topicsA, "active", roomId));
  await store.putSession(session(b, topicsB, "active", roomId));
  const room: Room = {
    id: roomId,
    state: "active",
    members: [a, b],
    devices: [`dev-${a}`, `dev-${b}`],
    accepted: [true, true],
    createdAt: 0,
    expiresAt: 0,
    activeSince: 0,
  };
  await store.putRoom(room);
  return { roomId, a, b };
}

function build(opts: { now?: () => number; random?: () => number } = {}) {
  const store = new MemoryStore();
  const emitter = fakeEmitter();
  const spark = new SparkService({ store, emitter, registry: new Registry(), ...opts });
  return { store, emitter, spark };
}

const request = (spark: SparkService, socketId: string, roomId: string) =>
  new Promise<SparkAck>((resolve) => void spark.request(socketId, roomId, resolve));

describe("SparkService", () => {
  test("shows the same prompt to both members, tagged you/partner, and counts it", async () => {
    let clock = 1_000;
    const { store, emitter, spark } = build({ now: () => clock });
    const { roomId, a, b } = await activeRoom(store, ["music"], ["music"]);
    const ack = await request(spark, a, roomId);
    if (!ack.ok) throw new Error(ack.error);
    expect(emitter.emitted).toEqual([
      { socketId: a, event: "spark:show", payload: { roomId, promptId: ack.promptId, from: "you", at: 1_000 } },
      { socketId: b, event: "spark:show", payload: { roomId, promptId: ack.promptId, from: "partner", at: 1_000 } },
    ]);
    const metric = await spark.sparkTotal.get();
    expect(metric.values[0]?.value).toBe(1);
    clock += SPARK.cooldownMs;
    const second = await request(spark, b, roomId);
    expect(second.ok).toBe(true);
    expect(emitter.emitted[2]?.payload).toMatchObject({ from: "you" });
    expect(emitter.emitted[2]?.socketId).toBe(b);
  });

  test("prefers prompts tagged with a topic both picked", async () => {
    const { store, spark } = build({ now: () => 0 });
    const { roomId, a } = await activeRoom(store, ["books", "gaming"], ["books", "sports"]);
    const ack = await request(spark, a, roomId);
    if (!ack.ok) throw new Error(ack.error);
    const prompt = SPARK_PROMPTS.find((p) => p.id === ack.promptId);
    expect(prompt?.topics).toContain("books");
  });

  test("falls back to any prompt when the pair shares no topic", async () => {
    const { store, spark } = build({ now: () => 0 });
    const { roomId, a } = await activeRoom(store, ["gaming"], ["sports"]);
    const ack = await request(spark, a, roomId);
    expect(ack.ok).toBe(true);
  });

  test("does not repeat any of the room's last prompts", async () => {
    let clock = 0;
    // random() always 0 picks the first candidate, so repeats would show up at once.
    const { store, spark } = build({ now: () => clock, random: () => 0 });
    const { roomId, a } = await activeRoom(store, ["general"], ["general"]);
    const seen: string[] = [];
    for (let i = 0; i <= SPARK.historySize; i += 1) {
      const ack = await request(spark, a, roomId);
      if (!ack.ok) throw new Error(ack.error);
      seen.push(ack.promptId);
      clock += SPARK.cooldownMs;
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("still answers once the catalog is exhausted", async () => {
    let clock = 0;
    const store = new MemoryStore();
    const emitter = fakeEmitter();
    const prompts = SPARK_PROMPTS.slice(0, 3);
    const spark = new SparkService({ store, emitter, registry: new Registry(), prompts, now: () => clock });
    const { roomId, a } = await activeRoom(store, ["general"], ["general"]);
    for (let i = 0; i < 6; i += 1) {
      const ack = await request(spark, a, roomId);
      expect(ack.ok).toBe(true);
      clock += SPARK.cooldownMs;
    }
  });

  test("one prompt per room per cooldown, whoever asks", async () => {
    let clock = 0;
    const { store, emitter, spark } = build({ now: () => clock });
    const { roomId, a, b } = await activeRoom(store, ["general"], ["general"]);
    expect((await request(spark, a, roomId)).ok).toBe(true);
    clock += SPARK.cooldownMs - 1;
    expect(await request(spark, b, roomId)).toEqual({ ok: false, error: "rate_limited" });
    expect(await request(spark, a, roomId)).toEqual({ ok: false, error: "rate_limited" });
    expect(emitter.emitted).toHaveLength(2);
    clock += 1;
    expect((await request(spark, b, roomId)).ok).toBe(true);
    expect(emitter.emitted).toHaveLength(4);
  });

  test("rejects sockets that are not an active member of the room", async () => {
    const { store, emitter, spark } = build({ now: () => 0 });
    const { roomId } = await activeRoom(store, ["general"], ["general"]);
    await store.putSession(session("stranger", ["general"], "waiting"));
    expect(await request(spark, "stranger", roomId)).toEqual({ ok: false, error: "not_in_room" });
    expect(await request(spark, "nobody", roomId)).toEqual({ ok: false, error: "not_in_room" });
    // A member naming another room.
    const other = await activeRoom(store, ["general"], ["general"]);
    expect(await request(spark, other.a, roomId)).toEqual({ ok: false, error: "not_in_room" });
    expect(emitter.emitted).toHaveLength(0);
  });
});

describe("spark catalog", () => {
  test("has at least 150 prompts with unique ids and known topics", () => {
    expect(SPARK_PROMPTS.length).toBeGreaterThanOrEqual(150);
    const ids = SPARK_PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const prompt of SPARK_PROMPTS) {
      expect(prompt.id).toMatch(/^[a-z]+-\d{2}$/);
      expect(prompt.topics.length).toBeGreaterThan(0);
      for (const topic of prompt.topics) expect(TOPICS).toContain(topic);
    }
  });

  test("every topic has prompts and every prompt has text in each language", () => {
    for (const topic of TOPICS) {
      expect(SPARK_PROMPTS.filter((p) => p.topics.includes(topic)).length).toBeGreaterThanOrEqual(10);
    }
    for (const prompt of SPARK_PROMPTS) {
      expect(prompt.en.trim().length).toBeGreaterThan(0);
      expect(prompt.hi.trim().length).toBeGreaterThan(0);
      // Hindi text really is Devanagari, not an English copy.
      expect(prompt.hi).toMatch(/[\u0900-\u097F]/);
    }
  });

  test("the generated client files carry the same ids in every language", () => {
    const perLang = PROMPT_LANGS.map((lang) => {
      const file = JSON.parse(promptFile(lang)) as { version: number; prompts: { id: string; text: string }[] };
      expect(file.version).toBe(1);
      return file.prompts.map((p) => p.id);
    });
    for (const ids of perLang) expect(ids).toEqual(SPARK_PROMPTS.map((p) => p.id));
  });
});
