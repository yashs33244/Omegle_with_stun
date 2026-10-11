import { describe, expect, test } from "bun:test";
import {
  AUTO_PAUSE_THRESHOLD,
  DAY,
  HIGH_WEIGHT,
  HOUR,
  MINUTE,
  evidenceShowable,
  kindFor,
  ladderStep,
  queueRank,
  reportSla,
  reportWeight,
  reporterWeight,
  restrictionReasonFor,
  routeRestricted,
  severityOf,
  takedownDueAt,
} from "../../src/enforcement/policy";
import type { DeviceStats } from "../../src/enforcement/types";

const NOW = 1_800_000_000_000;
const stats = (o: Partial<DeviceStats> = {}): DeviceStats => ({
  firstSeen: NOW,
  completedCalls: 0,
  upheld: 0,
  dismissed: 0,
  minorFlag: false,
  ...o,
});

describe("reporter weight", () => {
  test("fresh devices weigh little, so a handful of sybils cannot reach the threshold", () => {
    const fresh = reporterWeight(stats(), NOW);
    expect(fresh).toBeLessThan(0.25);
    expect(3 * fresh).toBeLessThan(AUTO_PAUSE_THRESHOLD);
    expect(7 * fresh).toBeLessThan(AUTO_PAUSE_THRESHOLD);
    expect(reporterWeight(stats({ firstSeen: null }), NOW)).toBe(fresh);
  });

  test("age, completed calls and an upheld record raise it, capped at 1", () => {
    const aged = reporterWeight(stats({ firstSeen: NOW - 3 * DAY }), NOW);
    const busy = reporterWeight(stats({ firstSeen: NOW - 3 * DAY, completedCalls: 10 }), NOW);
    const trusted = reporterWeight(stats({ firstSeen: NOW - 30 * DAY, completedCalls: 50, upheld: 5 }), NOW);
    expect(aged).toBeGreaterThan(reporterWeight(stats(), NOW));
    expect(busy).toBeGreaterThan(aged);
    expect(busy).toBeGreaterThanOrEqual(HIGH_WEIGHT);
    expect(trusted).toBe(1);
    // Two established reporters reach the threshold together, one does not.
    expect(busy).toBeLessThan(AUTO_PAUSE_THRESHOLD);
    expect(2 * busy).toBeGreaterThanOrEqual(AUTO_PAUSE_THRESHOLD);
  });

  test("reporters whose reports keep getting dismissed weigh 0", () => {
    expect(reporterWeight(stats({ firstSeen: NOW - 30 * DAY, completedCalls: 50, dismissed: 3 }), NOW)).toBe(0);
    expect(reporterWeight(stats({ dismissed: 2 }), NOW)).toBeGreaterThan(0);
    expect(reporterWeight(stats({ dismissed: 3, upheld: 3 }), NOW)).toBeGreaterThan(0);
  });

  test("short calls count half", () => {
    expect(reportWeight(0.8, true)).toBe(0.4);
    expect(reportWeight(0.8, false)).toBe(0.8);
  });
});

describe("severity and SLA clocks", () => {
  test("queue order: minor > nudity > harassment/hate/violence > spam/fake > other", () => {
    const order = (["other", "spam", "harassment", "nudity", "underage", "fake", "hate"] as const)
      .map((r) => ({ r, k: queueRank(r, false) }))
      .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1])
      .map((x) => x.r);
    expect(order.slice(0, 2)).toEqual(["underage", "nudity"]);
    expect(order.at(-1)).toBe("other");
    expect(order.indexOf("hate")).toBeLessThan(order.indexOf("spam"));
    expect(severityOf("spam", true)).toBe("critical");
    expect(queueRank("other", true)).toEqual(queueRank("underage", true));
  });

  test("24 h to acknowledge; 72 h to resolve nudity or minor reports, 15 days otherwise", () => {
    expect(reportSla("nudity", false, 0)).toEqual({ ackDueAt: DAY, resolveDueAt: 3 * DAY });
    expect(reportSla("underage", false, 0).resolveDueAt).toBe(3 * DAY);
    expect(reportSla("spam", true, 0).resolveDueAt).toBe(3 * DAY);
    expect(reportSla("spam", false, 0).resolveDueAt).toBe(15 * DAY);
  });

  test("takedown clocks", () => {
    expect(takedownDueAt("csam", 0)).toBe(DAY);
    expect(takedownDueAt("ncii", 0)).toBe(2 * DAY);
    expect(takedownDueAt("other", 0)).toBe(15 * DAY);
  });
});

describe("ladder", () => {
  test("warning, 10 min, 24 h, 7 days, then permanent", () => {
    expect(ladderStep("warn", 0)).toBe("warning");
    expect(ladderStep("warn", 4)).toBe("warning");
    expect(ladderStep("restrict", 0)).toBe(10 * MINUTE);
    expect(ladderStep("restrict", 1)).toBe(10 * MINUTE);
    expect(ladderStep("restrict", 2)).toBe(DAY);
    expect(ladderStep("restrict", 3)).toBe(7 * DAY);
    expect(ladderStep("restrict", 4)).toBeNull();
    expect(ladderStep("restrict", 9)).toBeNull();
  });

  test("kinds", () => {
    expect(kindFor(10 * MINUTE)).toBe("pause");
    expect(kindFor(HOUR)).toBe("pause");
    expect(kindFor(DAY)).toBe("ban");
    expect(kindFor(null)).toBe("ban");
  });
});

describe("reasons and evidence", () => {
  test("restriction reasons", () => {
    expect(restrictionReasonFor("fake", false)).toBe("fake-video");
    expect(restrictionReasonFor("inappropriate", false)).toBe("other");
    expect(restrictionReasonFor("nudity", true)).toBe("minor-safety");
    expect(restrictionReasonFor("underage", true)).toBe("underage");
  });

  test("evidence is never shown back for nudity, minor safety or restricted items", () => {
    expect(evidenceShowable("harassment", true, false)).toBe(true);
    expect(evidenceShowable("harassment", false, false)).toBe(false);
    expect(evidenceShowable("harassment", true, true)).toBe(false);
    expect(evidenceShowable("nudity", true, false)).toBe(false);
    expect(evidenceShowable("minor-safety", true, false)).toBe(false);
    expect(evidenceShowable("underage", true, false)).toBe(false);
  });
});

describe("CSAM routing", () => {
  test("underage always routes to the restricted path", () => {
    expect(routeRestricted({ reason: "underage", scores: null, minorSignal: false })).toBe(true);
  });

  test("nudity routes there when anything points to a minor", () => {
    expect(routeRestricted({ reason: "nudity", scores: null, minorSignal: false })).toBe(false);
    expect(routeRestricted({ reason: "nudity", scores: null, minorSignal: true })).toBe(true);
    expect(routeRestricted({ reason: "nudity", scores: { nsfw: 0.1, minor: 0.6 }, minorSignal: false })).toBe(true);
  });

  test("a frame that is both NSFW and possibly a minor routes there whatever the reason", () => {
    expect(routeRestricted({ reason: "spam", scores: { nsfw: 0.9, minor: 0.8 }, minorSignal: false })).toBe(true);
    expect(routeRestricted({ reason: "spam", scores: { nsfw: 0.9, minor: 0.1 }, minorSignal: false })).toBe(false);
    expect(routeRestricted({ reason: "spam", scores: { nsfw: 0.2, minor: 0.9 }, minorSignal: false })).toBe(false);
    expect(routeRestricted({ reason: "harassment", scores: null, minorSignal: true })).toBe(false);
  });
});
