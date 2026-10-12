/**
 * Property: whatever a client sends as a client -> server event, from any
 * session state, the server answers within the handler contract
 * (docs/PROTOCOL.md 1.6) and nothing else moves.
 *
 * Each run writes one raw Socket.IO packet (so payloads JSON.stringify cannot
 * produce reach the wire: duplicate and prototype keys, 1e400, NaN, lone
 * surrogates, nesting up to the parser's limit, strings near the 256 KiB frame
 * cap, extra or missing arguments, unknown and reserved event names) and checks:
 *   - a packet over the frame cap, that is not JSON or that names a reserved
 *     event closes the connection; nothing else does (unless the per-connection
 *     byte or packet budget ran out);
 *   - every ack is sent exactly once and is `{ ok: true, ... }` or
 *     `{ ok: false, error: ErrorCode }`; a payload the schema refuses gets
 *     `invalid_payload` (`unsupported_version` for a hello of another version),
 *     through the ack or a single `server:error`;
 *   - the partner receives nothing for a refused payload.
 * Over the whole suite: no handler error metric, no error log, no uncaught
 * exception, the heap returns near its baseline and a fresh pair still
 * reaches call:start.
 *
 * Per-socket event buckets are lifted (deps.newRateLimiter) so payloads reach
 * validation and handlers instead of `rate_limited`; the per-connection
 * packet and byte budgets stay as in production.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import pino from "pino";
import type { ZodTypeAny } from "zod";
import {
  PROTOCOL_VERSION,
  callFailedSchema,
  callSkipSchema,
  callTelemetrySchema,
  captionSegmentSchema,
  chatSendSchema,
  chatTypingSchema,
  helloSchema,
  moderationSignalSchema,
  reportSchema,
  roomRefSchema,
  rtcSignalSchema,
  sparkRequestSchema,
  updatePreferencesSchema,
  type ClientToServerEvents,
  type ErrorCode,
} from "../../src/protocol";
import {
  PACKET_BYTES_PER_CONNECTION,
  PACKET_RATE_PER_CONNECTION,
  SocketRateLimiter,
  type BucketSpec,
  type EventClass,
} from "../../src/rateLimit";
import { MAX_HTTP_BUFFER_SIZE } from "../../src/realtime/socket";
import { activePair, delay, hello, matchedPair, next, sendHello, startServer, type Client, type TestServer } from "../helpers";
import { Ref, SEED, deepNesting, extended, hugeString, leaf, mutated, obj, toJsonText, tree, type Fuzz } from "./arbitraries";

/** Time a refused event has to show up at the partner before the run counts it as silent. */
const SETTLE_MS = 15;
/** After a payload the schema accepts, the partner may receive a relay; let it land before the next run. */
const VALID_SETTLE_MS = 60;
const ACK_TIMEOUT_MS = 3_000;
/**
 * Heap growth over the suite that still counts as "back near baseline": a run
 * measures under 1 MB; one retained frame-sized payload per state rebuild would
 * add tens of MB.
 */
const HEAP_SLACK_BYTES = 16 * 1024 * 1024;

const ERROR_CODES: Record<ErrorCode, true> = {
  invalid_payload: true,
  rate_limited: true,
  not_in_room: true,
  bad_state: true,
  unsupported_version: true,
  banned: true,
  matching_closed: true,
  session_required: true,
  region_blocked: true,
  premium_required: true,
  internal: true,
};

/** socket.io-parser refuses these names (the connection closes); see its RESERVED_EVENTS. */
const RESERVED_EVENTS = ["connect", "connect_error", "disconnect", "disconnecting", "newListener", "removeListener"];

/** Partner events that carry the sender's content; they exist only inside an active call. */
const RELAYED = ["rtc:signal", "chat:message", "chat:typing", "caption:segment", "spark:show"];

const roomRef = obj({ roomId: new Ref("roomId") });

/** The schema socket.ts validates each event with, whether it acks, and a valid payload to mutate. */
const EVENTS = {
  "session:hello": {
    schema: helloSchema,
    ack: true,
    base: obj({
      protocolVersion: PROTOCOL_VERSION,
      deviceId: new Ref("deviceId"),
      profile: obj({ name: "Fuzz", country: "IN", language: "en", gender: "unspecified", topics: ["general"] }),
      preferences: obj({ genderFilter: "all", languageFilter: "any" }),
      mode: "preview",
    }),
  },
  "session:preferences": {
    schema: updatePreferencesSchema,
    ack: true,
    base: obj({ preferences: obj({ genderFilter: "all", languageFilter: "en" }) }),
  },
  "match:accept": { schema: roomRefSchema, ack: false, base: roomRef },
  "match:decline": { schema: roomRefSchema, ack: false, base: roomRef },
  "call:connected": { schema: roomRefSchema, ack: false, base: roomRef },
  "call:skip": { schema: callSkipSchema, ack: false, base: roomRef },
  "rtc:signal": {
    schema: rtcSignalSchema,
    ack: false,
    base: obj({
      roomId: new Ref("roomId"),
      candidate: obj({ candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host", sdpMid: "0", sdpMLineIndex: 0 }),
    }),
  },
  "chat:send": { schema: chatSendSchema, ack: true, base: obj({ roomId: new Ref("roomId"), text: "hello" }) },
  "chat:typing": { schema: chatTypingSchema, ack: false, base: obj({ roomId: new Ref("roomId"), typing: true }) },
  "report:submit": { schema: reportSchema, ack: true, base: obj({ roomId: new Ref("roomId"), reason: "spam" }) },
  "call:failed": { schema: callFailedSchema, ack: false, base: obj({ roomId: new Ref("roomId"), reason: "timeout" }) },
  "call:telemetry": {
    schema: callTelemetrySchema,
    ack: false,
    base: obj({ roomId: new Ref("roomId"), outcome: "connected", privateMode: false, rttMs: 20 }),
  },
  "moderation:signal": { schema: moderationSignalSchema, ack: false, base: obj({ roomId: new Ref("roomId"), kind: "no-face" }) },
  "spark:request": { schema: sparkRequestSchema, ack: true, base: roomRef },
  "caption:segment": {
    schema: captionSegmentSchema,
    ack: false,
    base: obj({ roomId: new Ref("roomId"), id: "seg-1", text: "hello there", final: true, lang: "en" }),
  },
} satisfies Record<keyof ClientToServerEvents, { schema: ZodTypeAny; ack: boolean; base: Fuzz }>;

type KnownEvent = keyof typeof EVENTS;
const KNOWN = Object.keys(EVENTS) as KnownEvent[];

/** One generated packet: event name, arguments (as wire text later) and whether it carries an ack id. */
interface Sent {
  event: string;
  args: Fuzz[];
  withAck: boolean;
}

const REFS = ["roomId", "deviceId"];
const fieldValue: fc.Arbitrary<Fuzz> = fc.oneof(
  { weight: 6, arbitrary: leaf(REFS) },
  { weight: 3, arbitrary: tree(REFS) },
  { weight: 1, arbitrary: hugeString(1_000, MAX_HTTP_BUFFER_SIZE + 16 * 1024) },
);

function payload(event: KnownEvent): fc.Arbitrary<Fuzz> {
  const { base } = EVENTS[event];
  return fc.oneof(
    { weight: 6, arbitrary: mutated(base, fieldValue) },
    { weight: 3, arbitrary: extended(base, fieldValue) },
    { weight: 3, arbitrary: tree(REFS) },
    { weight: 2, arbitrary: fc.constant(base) },
    { weight: 1, arbitrary: deepNesting(140_000) },
  );
}

const WEIRD_EVENTS = fc.oneof(
  fc.constantFrom(...RESERVED_EVENTS, "error", "__proto__", "constructor", "toString", "hasOwnProperty", "session:Hello", " chat:send", ""),
  fc.string({ unit: "binary", maxLength: 12 }),
);

const sent: fc.Arbitrary<Sent> = fc.oneof(
  {
    weight: 12,
    arbitrary: fc.constantFrom(...KNOWN).chain((event) =>
      fc.record({
        event: fc.constant<string>(event),
        args: fc.oneof(
          { weight: 8, arbitrary: payload(event).map((p) => [p]) },
          { weight: 1, arbitrary: fc.constant<Fuzz[]>([]) },
          { weight: 1, arbitrary: fc.tuple(payload(event), tree(REFS)).map((a): Fuzz[] => a) },
        ),
        withAck: fc.boolean(),
      }),
    ),
  },
  { weight: 1, arbitrary: fc.record({ event: WEIRD_EVENTS, args: fc.array(tree(REFS), { maxLength: 2 }), withAck: fc.boolean() }) },
);

/* ------------------------------------------------------------------ */
/* Session states                                                      */
/* ------------------------------------------------------------------ */

type StateName = "fresh" | "idle" | "waiting" | "pending" | "active";

interface Live {
  state: StateName;
  sender: Client;
  partner: Client | null;
  deviceId: string;
  roomId: string | null;
  /** Wire bytes and packets this run's sender connection has sent (budgets in limitedParser.ts). */
  bytes: number;
  packets: number;
  acks: Map<number, unknown[][]>;
  senderErrors: { code: string }[];
  partnerEvents: { event: string; roomId: unknown }[];
}

let ts: TestServer;
const logLines: string[] = [];
const uncaught: unknown[] = [];
const onUncaught = (err: unknown) => void uncaught.push(err);
let nextAckId = 1_000_000;

/** Counts raw ACK packets per id, so a second ack for one id is seen (socket.io-client drops it silently). */
function watch(live: Omit<Live, "acks" | "senderErrors" | "partnerEvents">): Live {
  const acks = new Map<number, unknown[][]>();
  const senderErrors: { code: string }[] = [];
  const partnerEvents: Live["partnerEvents"] = [];
  live.sender.io.engine.on("message", (data) => {
    if (typeof data !== "string") return;
    const m = /^3(\d+)(\[[\s\S]*\])$/.exec(data);
    if (!m) return;
    const id = Number(m[1]);
    acks.set(id, [...(acks.get(id) ?? []), JSON.parse(m[2]!) as unknown[]]);
  });
  live.sender.on("server:error", (p) => void senderErrors.push(p));
  live.partner?.onAny((event: string, p: unknown) =>
    partnerEvents.push({ event, roomId: typeof p === "object" && p !== null && "roomId" in p ? p.roomId : undefined }),
  );
  return { ...live, acks, senderErrors, partnerEvents };
}

/** Moves the hello'd sender out of the queue, as an accept timeout would. */
async function forceIdle(socketId: string): Promise<void> {
  await ts.store.withLock(async () => {
    const session = await ts.store.getSession(socketId);
    if (!session) throw new Error("no session to idle");
    await ts.store.removeWaiting(socketId);
    await ts.store.putSession({ ...session, state: "idle", roomId: undefined, waitingSince: undefined });
  });
}

/** Packets the helpers already sent on the sender's connection: CONNECT, then hello, then match:accept. */
const SETUP_PACKETS: Record<StateName, number> = { fresh: 1, idle: 2, waiting: 2, pending: 2, active: 3 };

async function enter(state: StateName): Promise<Live> {
  const base = { state, bytes: 0, packets: SETUP_PACKETS[state] };
  if (state === "fresh" || state === "idle" || state === "waiting") {
    const sender = await ts.connect();
    const deviceId = randomUUID();
    if (state !== "fresh") {
      const waiting = next(sender, "queue:waiting");
      const ack = await sendHello(sender, hello({ deviceId }));
      if (!ack.ok) throw new Error(`hello refused: ${ack.error}`);
      await waiting;
      if (state === "idle") await forceIdle(sender.id!);
    }
    return watch({ ...base, sender, partner: null, deviceId, roomId: null });
  }
  const a = hello();
  const pair = state === "pending" ? await matchedPair(ts, a) : await activePair(ts, a);
  return watch({ ...base, sender: pair.ca, partner: pair.cb, deviceId: a.deviceId, roomId: pair.roomId });
}

async function stillIn(live: Live): Promise<boolean> {
  if (!live.sender.connected || (live.partner && !live.partner.connected)) return false;
  const session = await ts.store.getSession(live.sender.id!);
  if (live.state === "fresh") return session === null;
  if (session?.state !== live.state) return false;
  if (!live.partner) return true;
  const partner = await ts.store.getSession(live.partner.id!);
  return session.roomId === live.roomId && partner?.roomId === live.roomId && partner.state === live.state;
}

/** Waits (polling, up to a second) until the server holds no session and no connection. */
async function drained(): Promise<void> {
  for (let i = 0; i < 200 && ((await ts.store.stats()).sessions > 0 || ts.server.io.engine.clientsCount > 0); i++) await delay(5);
}

/** Disconnects the state's clients and waits until the server has let go of them. */
async function leave(live: Live): Promise<void> {
  live.sender.disconnect();
  live.partner?.disconnect();
  await drained();
}

function packetText(s: Sent, ackId: number | null, ctx: Record<string, string>): string {
  return `2${ackId ?? ""}[${[JSON.stringify(s.event), ...s.args.map((a) => toJsonText(a, ctx))].join(",")}]`;
}

function parses(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function nestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 91 || c === 123) max = Math.max(max, ++depth);
    else if (c === 93 || c === 125) depth--;
  }
  return max;
}

/** Sends one packet from `live.sender` and checks the handler contract for it (throws with the packet on a violation). */
async function exercise(live: Live, s: Sent): Promise<void> {
  const ackId = s.withAck ? nextAckId++ : null;
  const text = packetText(s, ackId, { roomId: live.roomId ?? randomUUID(), deviceId: live.deviceId });
  const bytes = Buffer.byteLength(text);
  live.bytes += bytes;
  live.packets += 1;
  const json = parses(text.slice(text.indexOf("[")));
  const known = Object.hasOwn(EVENTS, s.event) ? EVENTS[s.event as KnownEvent] : null;
  const mustDrop = bytes > MAX_HTTP_BUFFER_SIZE || !json.ok || RESERVED_EVENTS.includes(s.event);
  // The budgets start full, so they cannot run out before this much was sent (small slack for the client's own packets).
  const mayDrop =
    mustDrop ||
    live.bytes > PACKET_BYTES_PER_CONNECTION.capacity - 16 * 1024 ||
    live.packets > PACKET_RATE_PER_CONNECTION.capacity - 4 ||
    // Near the engine's JSON nesting limit the server (deeper stack) may fail where this side parsed.
    nestingDepth(text) > 1_000;
  const raw: unknown = json.ok && Array.isArray(json.value) ? json.value[1] : undefined;
  const valid = known ? known.schema.safeParse(raw).success : false;
  const wrongVersion =
    s.event === "session:hello" && typeof raw === "object" && raw !== null && "protocolVersion" in raw && raw.protocolVersion !== PROTOCOL_VERSION;
  const expectedError: ErrorCode | null = known && !valid ? (wrongVersion ? "unsupported_version" : "invalid_payload") : null;

  live.partnerEvents.length = 0;
  live.senderErrors.length = 0;
  live.sender.io.engine.write(text);

  // Wait (polling, at most ACK_TIMEOUT_MS) for what must come: the drop, the ack, or the server:error for a refused payload.
  const waitFor = async (ready: () => boolean) => {
    const until = Date.now() + ACK_TIMEOUT_MS;
    while (!ready() && live.sender.connected && Date.now() < until) await delay(2);
  };
  if (mustDrop) await waitFor(() => false);
  else if (ackId !== null && known && (known.ack || expectedError)) await waitFor(() => (live.acks.get(ackId)?.length ?? 0) > 0);
  else if (expectedError) await waitFor(() => live.senderErrors.length > 0);
  await delay(valid ? VALID_SETTLE_MS : SETTLE_MS);

  const context = `${live.state} ${s.event} ${text.length > 300 ? `${text.slice(0, 300)}... (${bytes} bytes)` : text}`;
  if (!live.sender.connected) {
    if (!mayDrop) throw new Error(`connection closed for a packet that should not close it: ${context}`);
    return;
  }
  if (mustDrop) throw new Error(`connection stayed open: ${context}`);

  const acks = ackId === null ? [] : (live.acks.get(ackId) ?? []);
  if (acks.length > 1) throw new Error(`acked ${acks.length} times: ${context}`);
  if (ackId !== null && known?.ack && acks.length !== 1) throw new Error(`no ack: ${context}`);
  if (!known && acks.length > 0) throw new Error(`ack for an event without a handler: ${context}`);
  let ack: { ok: boolean; error: unknown } | null = null;
  if (acks.length === 1) {
    const res = acks[0]![0];
    if (typeof res !== "object" || res === null || !("ok" in res) || typeof res.ok !== "boolean") {
      throw new Error(`malformed ack ${JSON.stringify(res)}: ${context}`);
    }
    ack = { ok: res.ok, error: "error" in res ? res.error : undefined };
    if (!ack.ok && !(typeof ack.error === "string" && Object.hasOwn(ERROR_CODES, ack.error))) {
      throw new Error(`ack with an unknown error ${JSON.stringify(res)}: ${context}`);
    }
  }
  if (expectedError) {
    const got = ackId !== null ? ack?.error : live.senderErrors[0]?.code;
    if (got !== expectedError) throw new Error(`expected ${expectedError}, got ${String(got)}: ${context}`);
    if (ackId === null && live.senderErrors.length !== 1) throw new Error(`${live.senderErrors.length} server:error for one packet: ${context}`);
  }
  const refused = !valid || ack?.ok === false || live.senderErrors.length > 0;
  const seen = live.partnerEvents.map((e) => e.event).join(", ");
  if (refused && live.partnerEvents.length > 0) throw new Error(`partner received ${seen} for a refused payload: ${context}`);
  // Whatever the sender's payload names, the partner only ever hears about the room they share,
  // and nothing is relayed before the call is active.
  if (live.partnerEvents.some((e) => e.roomId !== undefined && e.roomId !== live.roomId)) {
    throw new Error(`partner received an event for another room (${seen}): ${context}`);
  }
  if (live.state !== "active" && live.partnerEvents.some((e) => RELAYED.includes(e.event))) {
    throw new Error(`partner received a relay (${seen}) outside an active call: ${context}`);
  }
}

async function metric(name: string): Promise<number> {
  const m = ts.server.metrics.registry.getSingleMetric(name);
  if (!m) throw new Error(`no metric ${name}`);
  return (await m.get()).values.reduce((sum, v) => sum + v.value, 0);
}

const LIFTED = { capacity: 1e9, refillPerSec: 1e9 };
const UNLIMITED: Record<EventClass, BucketSpec> = {
  hello: LIFTED,
  preferences: LIFTED,
  control: LIFTED,
  signal: LIFTED,
  chat: LIFTED,
  typing: LIFTED,
  report: LIFTED,
  telemetry: LIFTED,
};

let heapBaseline = 0;

beforeAll(async () => {
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);
  const logger = pino({ level: "warn" }, { write: (line: string) => void logLines.push(line) });
  ts = await startServer(
    // Pending rooms must outlive the runs against them; no hello deadline mid-suite.
    { matchAcceptTimeoutMs: 120_000, helloTimeoutMs: 120_000 },
    undefined,
    { logger, newRateLimiter: () => new SocketRateLimiter(UNLIMITED) },
  );
  Bun.gc(true);
  heapBaseline = process.memoryUsage().heapUsed;
});

afterAll(async () => {
  process.off("uncaughtException", onUncaught);
  process.off("unhandledRejection", onUncaught);
  await ts?.close();
});

const RUNS: Record<StateName, number> = { fresh: 70, idle: 40, waiting: 40, pending: 60, active: 80 };

describe("client -> server events under arbitrary payloads", () => {
  for (const state of Object.keys(RUNS) as StateName[]) {
    test(
      `${state}: every packet gets the contracted answer and nothing reaches the partner for a refused one`,
      async () => {
        let live = await enter(state);
        try {
          await fc.assert(
            fc.asyncProperty(sent, async (s) => {
              if (!(await stillIn(live))) {
                await leave(live);
                live = await enter(state);
              }
              await exercise(live, s);
            }),
            { seed: SEED, numRuns: RUNS[state], endOnFailure: true },
          );
        } finally {
          await leave(live);
        }
      },
      120_000,
    );
  }

  test("afterwards: no handler error, no error log, no uncaught exception, heap near baseline, matching still works", async () => {
    expect(await metric("chizzy_handler_errors_total")).toBe(0);
    expect(logLines.filter((l) => (JSON.parse(l) as { level: number }).level >= 50)).toEqual([]);
    expect(uncaught).toEqual([]);
    const control = await activePair(ts);
    expect(control.startA.roomId).toBe(control.roomId);
    expect(control.startB.roomId).toBe(control.roomId);
    control.ca.disconnect();
    control.cb.disconnect();
    await drained();
    expect(await ts.store.stats()).toEqual({ sessions: 0, waiting: 0, pendingRooms: 0, activeRooms: 0 });
    expect(await metric("chizzy_connected_sockets")).toBe(0);
    expect(ts.server.io.engine.clientsCount).toBe(0);
    Bun.gc(true);
    expect(process.memoryUsage().heapUsed - heapBaseline).toBeLessThan(HEAP_SLACK_BYTES);
  });
});
