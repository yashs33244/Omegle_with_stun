/**
 * Every zod schema exported by protocol.ts, taken by introspection so a new
 * schema is covered without editing this file:
 *   - every string and array it accepts has an upper bound (a field without
 *     one is a payload the server must hold and scan at whatever size the
 *     transport lets through);
 *   - it parses arbitrary wire values, including 256 KiB strings, 60 000-item
 *     arrays and regex-hostile data URLs in every field, in bounded time.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { ZodFirstPartyTypeKind, type ZodTypeAny, ZodType } from "zod";
import * as protocol from "../../src/protocol";
import { MAX_HTTP_BUFFER_SIZE } from "../../src/realtime/socket";
import { SEED, deepNesting, hugeString, obj, shortString, toJsonText, tree, type Fuzz } from "./arbitraries";

const SCHEMAS = Object.entries<unknown>(protocol).filter((e): e is [string, ZodTypeAny] => e[1] instanceof ZodType);

/** Slowest acceptable single safeParse of a frame-sized input (a linear scan of 256 KiB takes about a millisecond). */
const PARSE_BUDGET_MS = 100;

/**
 * Paths (`schema.field[]`) that accept a string or array of any length. A
 * string counts as bounded with a max or length check, or with zod's uuid
 * check (a fixed 36-character format). Types this walker does not know are
 * reported too, so a new kind of schema is looked at rather than skipped.
 */
function unbounded(schema: ZodTypeAny, path: string): string[] {
  const def = schema._def;
  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodString: {
      const checks = def.checks as { kind: string }[];
      return checks.some((c) => c.kind === "max" || c.kind === "length" || c.kind === "uuid") ? [] : [path];
    }
    case ZodFirstPartyTypeKind.ZodArray: {
      const own = def.maxLength || def.exactLength ? [] : [path];
      return [...own, ...unbounded(def.type, `${path}[]`)];
    }
    case ZodFirstPartyTypeKind.ZodObject: {
      const open = def.unknownKeys === "passthrough" || def.catchall._def.typeName !== ZodFirstPartyTypeKind.ZodNever ? [`${path}{...}`] : [];
      const shape = def.shape() as Record<string, ZodTypeAny>;
      return [...open, ...Object.entries(shape).flatMap(([k, v]) => unbounded(v, `${path}.${k}`))];
    }
    case ZodFirstPartyTypeKind.ZodOptional:
    case ZodFirstPartyTypeKind.ZodNullable:
    case ZodFirstPartyTypeKind.ZodDefault:
      return unbounded(def.innerType, path);
    case ZodFirstPartyTypeKind.ZodEffects:
      return unbounded(def.schema, path);
    case ZodFirstPartyTypeKind.ZodUnion:
      return (def.options as ZodTypeAny[]).flatMap((o, i) => unbounded(o, `${path}|${i}`));
    case ZodFirstPartyTypeKind.ZodLiteral:
    case ZodFirstPartyTypeKind.ZodEnum:
    case ZodFirstPartyTypeKind.ZodBoolean:
    case ZodFirstPartyTypeKind.ZodNumber:
    case ZodFirstPartyTypeKind.ZodNull:
      return [];
    default:
      return [`${path} (${String(def.typeName)}: not understood by this test)`];
  }
}

/**
 * Wire values shaped like `schema` (every known field present, so each field's
 * checks run) with hostile leaves: frame-sized strings, regex-hostile data
 * URLs, huge arrays, deep nesting, wrong types.
 */
function shaped(schema: ZodTypeAny): fc.Arbitrary<Fuzz> {
  const def = schema._def;
  const hostile = fc.oneof(
    { weight: 2, arbitrary: hugeString(1_000, MAX_HTTP_BUFFER_SIZE) },
    { weight: 2, arbitrary: shortString },
    { weight: 1, arbitrary: tree() },
    { weight: 1, arbitrary: deepNesting(2_000) },
    { weight: 1, arbitrary: fc.integer({ min: 1_000, max: 60_000 }).map((n): Fuzz => Array.from({ length: n }, () => "general")) },
  );
  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodObject: {
      const shape = def.shape() as Record<string, ZodTypeAny>;
      return fc.record(Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, shaped(v)]))).map(obj);
    }
    case ZodFirstPartyTypeKind.ZodArray:
      return fc.oneof(fc.array(shaped(def.type), { maxLength: 30 }), hostile);
    case ZodFirstPartyTypeKind.ZodOptional:
    case ZodFirstPartyTypeKind.ZodNullable:
    case ZodFirstPartyTypeKind.ZodDefault:
      return shaped(def.innerType);
    case ZodFirstPartyTypeKind.ZodEffects:
      return shaped(def.schema);
    case ZodFirstPartyTypeKind.ZodUnion:
      return fc.oneof(...(def.options as ZodTypeAny[]).map(shaped));
    default:
      return hostile;
  }
}

describe("protocol.ts schemas", () => {
  test("every string and array field has an upper bound", () => {
    expect(SCHEMAS.length).toBeGreaterThan(20);
    expect(SCHEMAS.flatMap(([name, schema]) => unbounded(schema, name))).toEqual([]);
  });

  test("every schema parses arbitrary and frame-sized input in bounded time", () => {
    for (const [name, schema] of SCHEMAS) {
      fc.assert(
        fc.property(fc.oneof(shaped(schema), tree(), hugeString(1, MAX_HTTP_BUFFER_SIZE)), (value) => {
          let wire: unknown;
          try {
            wire = JSON.parse(toJsonText(value));
          } catch {
            return; // not JSON (a NaN token): the transport refuses it before any schema runs
          }
          const started = performance.now();
          schema.safeParse(wire);
          const ms = performance.now() - started;
          if (ms >= PARSE_BUDGET_MS) throw new Error(`${name}.safeParse took ${ms.toFixed(1)} ms`);
        }),
        { seed: SEED, numRuns: 40 },
      );
    }
  });
});
