/**
 * Shared generators for the property tests: JSON-ish values that reach the
 * corners a hand-written test skips (prototype keys, duplicate keys, lone
 * surrogates, numbers JSON.stringify cannot write, strings near the frame
 * cap, nesting up to the parser's limit) and a serializer that writes them
 * as wire text.
 *
 * A value is a tree of `Fuzz` nodes. Objects are entry lists (`Obj`) so keys
 * such as `__proto__` and duplicate keys survive to the wire; `Raw` is JSON
 * text written verbatim (`1e400`, `-0`, `NaN`); `Ref` is filled in at send
 * time from a context (the room or device id that is live when the run sends).
 */
import fc from "fast-check";

/** JSON text written verbatim. */
export class Raw {
  constructor(readonly text: string) {}
}

/** A context value resolved when the payload is serialized. */
export class Ref {
  constructor(readonly key: string) {}
}

/** An object as an ordered entry list (duplicates and `__proto__` allowed). */
export class Obj {
  constructor(readonly entries: [string, Fuzz][]) {}
}

export type Fuzz = null | boolean | number | string | Raw | Ref | Obj | Fuzz[];

/** Fixed seed for every property in the suite, so a CI failure replays locally. */
export const SEED = 0x5eed;

/** Writes `value` as wire text; `ctx` resolves `Ref`s (a missing key is written as null). */
export function toJsonText(value: Fuzz, ctx: Record<string, string> = {}): string {
  if (value instanceof Raw) return value.text;
  if (value instanceof Ref) return JSON.stringify(ctx[value.key] ?? null);
  if (value instanceof Obj) {
    return `{${value.entries.map(([k, v]) => `${JSON.stringify(k)}:${toJsonText(v, ctx)}`).join(",")}}`;
  }
  if (Array.isArray(value)) return `[${value.map((v) => toJsonText(v, ctx)).join(",")}]`;
  // JSON.stringify writes NaN and Infinity as null, as socket.io-client would.
  return JSON.stringify(value);
}

/** Builds an `Obj` from a plain object literal (keys in insertion order). */
export function obj(fields: Record<string, Fuzz>): Obj {
  return new Obj(Object.entries(fields));
}

/** Keys that are special to JavaScript objects or that the schemas use. */
const PROTOTYPE_KEYS = ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "__defineGetter__", "then"];

/** Number tokens: overflow to Infinity, negative zero, underflow, beyond 2^53, and invalid JSON (NaN, Infinity, hex). */
const NUMBER_TOKENS = ["1e400", "-1e400", "-0", "1e-400", "9007199254740993", "-9007199254740993", "1.7976931348623157e308", "5e-324", "NaN", "Infinity", "-Infinity", "0x10", "01", "1."];

/** Strings that sit on a validation edge or a unicode edge. */
export const EDGE_STRINGS = [
  "",
  " ",
  "   \t\n ",
  "\u0000",
  "\ud800",
  "\udfff",
  "\ud83d",
  "a\ud800b",
  "\u202e",
  "\ufeff",
  "\u200b",
  "a\u0301",
  "😀",
  "👩‍👩‍👧‍👦",
  "𝕏",
  "\r\n",
  "<script>alert(1)</script>",
  "../../etc/passwd",
  "%00",
  "${process.exit()}",
  "{{constructor.constructor('x')()}}",
  "null",
  "undefined",
  "NaN",
  "Infinity",
  "true",
  "[object Object]",
  "__proto__",
  "00000000-0000-0000-0000-000000000000",
  "FFFFFFFF-FFFF-4FFF-BFFF-FFFFFFFFFFFF",
  " 6f1c2c8e-3d6b-4b5e-9a3e-2f1d0c9b8a7f",
  "6f1c2c8e-3d6b-4b5e-9a3e-2f1d0c9b8a7f\n",
  "data:image/jpeg;base64,",
  "data:image/jpeg;base64,AAAA",
  "data:image/svg+xml;base64,PHN2Zz4=",
  "data:image/jpeg;base64,AAAA====",
  "en",
  "EN",
  "en-US-x-123456789",
  "IN",
  "in",
  "1990-01-01",
  "9999-99-99",
  "a".repeat(64),
  "candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host",
  "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n",
  "x".repeat(501),
  " ".repeat(600),
];

const UTF8 = new TextEncoder();

/**
 * A string of about `bytes` UTF-8 bytes built from one repeated unit (ASCII,
 * two-byte, astral, NUL, space) or a data URL whose base64 tail breaks only
 * at the very end, the worst case for the anchored data URL patterns.
 */
export const hugeString = (minBytes: number, maxBytes: number): fc.Arbitrary<string> =>
  fc
    .record({
      unit: fc.constantFrom("a", "é", "😀", "\u0000", " ", "\ud800", "<"),
      bytes: fc.integer({ min: minBytes, max: maxBytes }),
      shape: fc.constantFrom("repeat", "data-url", "trailing-bang"),
    })
    .map(({ unit, bytes, shape }) => {
      if (shape === "data-url") return `data:image/jpeg;base64,${"A".repeat(Math.max(0, bytes - 23))}!`;
      const body = unit.repeat(Math.max(1, Math.ceil(bytes / UTF8.encode(unit).length)));
      return shape === "trailing-bang" ? `${body}!` : body;
    });

/** Short strings: arbitrary code points (lone surrogates included), edge strings, small repeats. */
export const shortString: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.string({ unit: "binary", maxLength: 24 }) },
  { weight: 3, arbitrary: fc.constantFrom(...EDGE_STRINGS) },
  { weight: 1, arbitrary: fc.uuid() },
  { weight: 1, arbitrary: fc.string({ unit: "grapheme", minLength: 490, maxLength: 1_100 }) },
);

const number: fc.Arbitrary<Fuzz> = fc.oneof(
  fc.integer(),
  fc.double(),
  fc.constantFrom(0, -1, 1, 64, 65, 2 ** 31, 2 ** 53, -(2 ** 53), 600_000, 86_400_001),
  fc.constantFrom(...NUMBER_TOKENS).map((t) => new Raw(t)),
);

const key: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...PROTOTYPE_KEYS),
  fc.constantFrom("roomId", "deviceId", "text", "profile", "preferences", "candidate", "description", "evidence", "age", "id"),
  fc.string({ unit: "binary", maxLength: 8 }),
);

/** Leaves, with `refs` (context keys) mixed in so values also land on a live id. */
export function leaf(refs: string[] = []): fc.Arbitrary<Fuzz> {
  const arbs: fc.Arbitrary<Fuzz>[] = [fc.constant(null), fc.boolean(), number, shortString];
  if (refs.length > 0) arbs.push(fc.constantFrom(...refs).map((k) => new Ref(k)));
  return fc.oneof(...arbs);
}

/** Arbitrary JSON-ish trees: arrays, entry-list objects (prototype and duplicate keys), any leaf. */
export function tree(refs: string[] = []): fc.Arbitrary<Fuzz> {
  const { value } = fc.letrec<{ value: Fuzz; node: Fuzz }>((tie) => ({
    value: fc.oneof({ depthSize: "small", withCrossShrink: true }, leaf(refs), tie("node")),
    node: fc.oneof(
      fc.array(tie("value"), { maxLength: 4 }),
      fc.array(fc.tuple(key, tie("value")), { maxLength: 4 }).map((entries) => new Obj(entries)),
    ),
  }));
  return value;
}

/** `[[[...]]]` or `{"a":{"a":...}}` up to `maxDepth` levels, as raw text (no recursion on the way out). */
export const deepNesting = (maxDepth: number): fc.Arbitrary<Fuzz> =>
  fc
    .record({ depth: fc.integer({ min: 1, max: maxDepth }), shape: fc.constantFrom("array", "object") })
    .map(({ depth, shape }) =>
      new Raw(shape === "array" ? `${"[".repeat(depth)}${"]".repeat(depth)}` : `${'{"a":'.repeat(depth)}null${"}".repeat(depth)}`),
    );

/** One structural change to a valid value: a field replaced, dropped or added, or the value wrapped. */
type Mutation =
  | { op: "set"; path: number[]; key: string | null; value: Fuzz }
  | { op: "drop"; path: number[] }
  | { op: "wrap"; path: number[] };

function mutation(payloadValue: fc.Arbitrary<Fuzz>): fc.Arbitrary<Mutation> {
  const path = fc.array(fc.nat(), { minLength: 1, maxLength: 4 });
  return fc.oneof(
    { weight: 4, arbitrary: fc.record({ op: fc.constant("set" as const), path, key: fc.option(key, { nil: null }), value: payloadValue }) },
    { weight: 2, arbitrary: fc.record({ op: fc.constant("drop" as const), path }) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant("wrap" as const), path }) },
  );
}

/**
 * Applies `m`: every path step but the last picks a child (modulo the child
 * count) to descend into; the last step picks the field or item to change.
 * A node without children is changed itself.
 */
function apply(value: Fuzz, m: Mutation, depth = 0): Fuzz {
  const children = value instanceof Obj ? value.entries.length : Array.isArray(value) ? value.length : 0;
  const at = children > 0 ? m.path[depth]! % children : 0;
  if (depth < m.path.length - 1 && children > 0) {
    if (value instanceof Obj) return new Obj(value.entries.map(([k, v], i) => [k, i === at ? apply(v, m, depth + 1) : v]));
    if (Array.isArray(value)) return value.map((v, i) => (i === at ? apply(v, m, depth + 1) : v));
  }
  if (m.op === "wrap") return [value];
  if (value instanceof Obj) {
    if (m.op === "drop") return new Obj(value.entries.filter((_, i) => i !== at));
    if (m.key !== null) return new Obj([...value.entries, [m.key, m.value]]);
    return new Obj(value.entries.map(([k, v], i) => [k, i === at ? m.value : v]));
  }
  if (Array.isArray(value) && children > 0) {
    if (m.op === "drop") return value.filter((_, i) => i !== at);
    return value.map((v, i) => (i === at ? m.value : v));
  }
  return m.op === "set" ? m.value : null;
}

/** `base` with one to three mutations; the replacement values come from `payloadValue`. */
export function mutated(base: Fuzz, payloadValue: fc.Arbitrary<Fuzz>): fc.Arbitrary<Fuzz> {
  return fc.array(mutation(payloadValue), { minLength: 1, maxLength: 3 }).map((ms) => ms.reduce((v, m) => apply(v, m), base));
}

/**
 * `base` with extra top-level fields the schema does not name (prototype keys
 * included), which zod strips: still valid, so the handlers behind the
 * schema run with it.
 */
export function extended(base: Obj, extraValue: fc.Arbitrary<Fuzz>): fc.Arbitrary<Fuzz> {
  const known = new Set(base.entries.map(([k]) => k));
  return fc
    .array(fc.tuple(key.filter((k) => !known.has(k)), extraValue), { minLength: 1, maxLength: 3 })
    .map((extra) => new Obj([...base.entries, ...extra]));
}
