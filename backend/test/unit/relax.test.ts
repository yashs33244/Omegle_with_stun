import { describe, expect, test } from "bun:test";
import type { Candidate } from "../../src/match/compatibility";
import { HELD, MAX_STEP, meetsPreferences, pairStep, relaxStep } from "../../src/match/relax";
import type { Topic } from "../../src/protocol";

const ladder = { relaxTopicsAfterMs: 5_000, relaxLanguageAfterMs: 10_000, lowPriorityDelayMs: 4_000 };

function cand(language: string, topics: Topic[], languageFilter = "any"): Candidate {
  return {
    deviceId: Math.random().toString(36),
    profile: { gender: "unspecified", language, topics },
    preferences: { genderFilter: "all", languageFilter },
  };
}

describe("relaxStep", () => {
  test.each([
    [0, 0],
    [4_999, 0],
    [5_000, 1],
    [9_999, 1],
    [10_000, MAX_STEP],
    [60_000, MAX_STEP],
  ])("waited %p ms -> step %p", (waited, step) => {
    expect(relaxStep(waited, ladder)).toBe(step);
  });

  test("low priority is held back, then climbs the same ladder later", () => {
    expect(relaxStep(0, ladder, true)).toBe(HELD);
    expect(relaxStep(3_999, ladder, true)).toBe(HELD);
    expect(relaxStep(4_000, ladder, true)).toBe(0);
    expect(relaxStep(9_000, ladder, true)).toBe(1);
    expect(relaxStep(14_000, ladder, true)).toBe(MAX_STEP);
  });
});

describe("meetsPreferences", () => {
  const enMusic = cand("en", ["music"]);
  const enArt = cand("en-GB", ["art"]);
  const hiMusic = cand("hi", ["music"]);

  test("step 0 needs a shared topic and the same language", () => {
    expect(meetsPreferences(enMusic, cand("en-US", ["music", "art"]), 0)).toBe(true);
    expect(meetsPreferences(enMusic, enArt, 0)).toBe(false);
    expect(meetsPreferences(enMusic, hiMusic, 0)).toBe(false);
  });

  test("step 1 drops topics but keeps the same-language preference", () => {
    expect(meetsPreferences(enMusic, enArt, 1)).toBe(true);
    expect(meetsPreferences(enMusic, hiMusic, 1)).toBe(false);
  });

  test("step 2 accepts anyone (hard rules are checked separately)", () => {
    expect(meetsPreferences(enMusic, hiMusic, 2)).toBe(true);
  });

  test("a language filter replaces the soft same-language preference", () => {
    const wantsHindi = cand("en", ["music"], "hi");
    expect(meetsPreferences(wantsHindi, hiMusic, 0)).toBe(true);
  });

  test("held devices never match", () => {
    expect(meetsPreferences(enMusic, cand("en", ["music"]), HELD)).toBe(false);
  });
});

test("pairStep uses the more relaxed side unless one is held", () => {
  expect(pairStep(0, 2)).toBe(2);
  expect(pairStep(1, 0)).toBe(1);
  expect(pairStep(HELD, 2)).toBe(HELD);
});
