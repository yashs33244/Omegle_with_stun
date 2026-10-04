import { describe, expect, test } from "bun:test";
import { isCompatible, primaryLanguage, type Candidate } from "../../src/match/compatibility";
import type { Gender, GenderFilter, Topic } from "../../src/protocol";

let n = 0;
function cand(
  opts: {
    gender?: Gender;
    genderFilter?: GenderFilter;
    language?: string;
    languageFilter?: string;
    topics?: Topic[];
    deviceId?: string;
  } = {},
): Candidate {
  return {
    deviceId: opts.deviceId ?? `device-${++n}`,
    profile: { gender: opts.gender ?? "unspecified", language: opts.language ?? "en", topics: opts.topics ?? ["general"] },
    preferences: { genderFilter: opts.genderFilter ?? "all", languageFilter: opts.languageFilter ?? "any" },
  };
}

describe("isCompatible", () => {
  test("same device never matches itself", () => {
    expect(isCompatible(cand({ deviceId: "x" }), cand({ deviceId: "x" }))).toBe(false);
  });

  test("topics are not a hard rule (they relax, see relax.test.ts)", () => {
    expect(isCompatible(cand({ topics: ["music", "art"] }), cand({ topics: ["art"] }))).toBe(true);
    expect(isCompatible(cand({ topics: ["music"] }), cand({ topics: ["art"] }))).toBe(true);
  });

  const genderTable: [Gender, GenderFilter, Gender, GenderFilter, boolean][] = [
    ["male", "all", "female", "all", true],
    ["male", "female", "female", "all", true],
    ["male", "female", "female", "male", true],
    ["male", "female", "female", "female", false], // B only wants female
    ["male", "male", "female", "all", false], // A wants male, B is female
    ["unspecified", "all", "male", "all", true],
    ["unspecified", "all", "male", "female", false], // unspecified only meets "all"
    ["unspecified", "all", "female", "female", false],
    ["other", "all", "male", "other", true],
    ["other", "other", "other", "other", true],
  ];
  test.each(genderTable)("gender %s/%s vs %s/%s -> %p", (ga, fa, gb, fb, expected) => {
    const a = cand({ gender: ga, genderFilter: fa });
    const b = cand({ gender: gb, genderFilter: fb });
    expect(isCompatible(a, b)).toBe(expected);
    expect(isCompatible(b, a)).toBe(expected);
  });

  const languageTable: [string, string, string, string, boolean][] = [
    ["en", "any", "hi", "any", true],
    ["en", "hi", "hi", "any", true],
    ["en", "hi", "hi", "en", true],
    ["en", "hi", "en", "any", false],
    ["en", "any", "hi", "fr", false],
    ["en-US", "any", "en-GB", "en", true], // primary subtag match
    ["hi", "en", "en-IN", "any", true],
  ];
  test.each(languageTable)("language %s/%s vs %s/%s -> %p", (la, fa, lb, fb, expected) => {
    const a = cand({ language: la, languageFilter: fa });
    const b = cand({ language: lb, languageFilter: fb });
    expect(isCompatible(a, b)).toBe(expected);
    expect(isCompatible(b, a)).toBe(expected);
  });

  test("primaryLanguage", () => {
    expect(primaryLanguage("en-US")).toBe("en");
    expect(primaryLanguage("HI")).toBe("hi");
  });
});
