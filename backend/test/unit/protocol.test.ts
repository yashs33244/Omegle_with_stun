import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  LIMITS,
  captionSegmentSchema,
  chatSendSchema,
  flagsSchema,
  helloSchema,
  rtcSignalSchema,
  sessionRequestSchema,
} from "../../src/protocol";
import { hello, profile, sessionBody } from "../helpers";

describe("protocol schemas", () => {
  test("a valid hello parses", () => {
    expect(helloSchema.safeParse(hello()).success).toBe(true);
  });

  test("remote photo URLs are rejected, inline images accepted", () => {
    const remote = hello({ profile: profile({ photo: "https://evil.example.com/pixel.png" }) });
    expect(helloSchema.safeParse(remote).success).toBe(false);
    const inline = hello({ profile: profile({ photo: "data:image/jpeg;base64,AAAA" }) });
    expect(helloSchema.safeParse(inline).success).toBe(true);
  });

  test("oversized payloads are rejected", () => {
    const bigPhoto = `data:image/jpeg;base64,${"A".repeat(LIMITS.photoMaxChars)}`;
    expect(helloSchema.safeParse(hello({ profile: profile({ photo: bigPhoto }) })).success).toBe(false);
    expect(helloSchema.safeParse(hello({ profile: profile({ name: "x".repeat(LIMITS.nameMax + 1) }) })).success).toBe(
      false,
    );
    const roomId = randomUUID();
    expect(chatSendSchema.safeParse({ roomId, text: "x".repeat(LIMITS.chatMax + 1) }).success).toBe(false);
    expect(
      rtcSignalSchema.safeParse({ roomId, description: { type: "offer", sdp: "x".repeat(LIMITS.sdpMax + 1) } }).success,
    ).toBe(false);
  });

  test("pattern-only strings are capped by length too (found by test/property/schemas.test.ts)", () => {
    const tooBig = (r: { success: boolean; error?: { issues: { code: string }[] } }) => r.error?.issues.some((i) => i.code === "too_big") ?? false;
    const long = "x".repeat(5_000);
    expect(tooBig(helloSchema.safeParse(hello({ profile: profile({ language: `en-${long}` }) })))).toBe(true);
    expect(tooBig(helloSchema.safeParse(hello({ profile: profile({ country: `IN${long}` }) })))).toBe(true);
    expect(tooBig(sessionRequestSchema.safeParse({ ...sessionBody(), fingerprint: "a".repeat(65) }))).toBe(true);
    expect(tooBig(captionSegmentSchema.safeParse({ roomId: randomUUID(), id: "a".repeat(65), text: "hi", final: true, lang: "en" }))).toBe(true);
    expect(tooBig(flagsSchema.partial().safeParse({ blocked_countries: Array(300).fill("IN").join(",") }))).toBe(true);
  });

  test("topics must be a non-empty array of known topics", () => {
    const bad = { ...hello(), profile: { ...profile(), topics: "general" } };
    expect(helloSchema.safeParse(bad).success).toBe(false);
    expect(helloSchema.safeParse(hello({ profile: profile({ topics: [] }) })).success).toBe(false);
  });

  test("rtc:signal needs exactly one of description or candidate", () => {
    const roomId = randomUUID();
    expect(rtcSignalSchema.safeParse({ roomId }).success).toBe(false);
    expect(
      rtcSignalSchema.safeParse({
        roomId,
        description: { type: "offer", sdp: "v=0" },
        candidate: { candidate: "c" },
      }).success,
    ).toBe(false);
    expect(rtcSignalSchema.safeParse({ roomId, candidate: { candidate: "c", sdpMid: "0" } }).success).toBe(true);
  });
});
