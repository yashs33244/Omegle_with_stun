import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { ReportInput } from "../../src/enforcement/EnforcementService";
import { parseEvidenceFrame } from "../../src/enforcement/evidence";
import { ADMIN_LIST_LIMIT, APPEALS_PER_IP_PER_HOUR, AUTO_PAUSE_MS, DAY, MINUTE, YEAR } from "../../src/enforcement/constants";
import type { StoredReport, StoredRestriction } from "../../src/enforcement/types";
import { RESTRICTION_DURATIONS_MS, type ReportReason } from "../../src/protocol";
import { harness, jpegDataUrl, type Harness } from "../enforcementFixtures";

let h: Harness;
afterEach(() => rmSync(h.dir, { recursive: true, force: true }));

const actor = { ip: "198.51.100.1" };

/** A reporter with history: 3 days old with 10 completed calls (weight about 0.83). */
async function establishedDevice(): Promise<string> {
  const id = randomUUID();
  await h.store.setFieldIfAbsent(`dev:${id}`, "firstSeen", h.clock.now - 4 * DAY, YEAR);
  await h.store.incrField(`dev:${id}`, "completedCalls", 10, YEAR);
  return id;
}

function input(reportedDevice: string, o: Partial<ReportInput> = {}): ReportInput {
  return {
    roomId: randomUUID(),
    reporterDevice: randomUUID(),
    reporterIp: null,
    reportedDevice,
    reason: "harassment",
    frame: null,
    activeSince: h.clock.now - 60_000,
    endedAt: null,
    ...o,
  };
}

async function report(reported: string, reason: ReportReason, o: Partial<ReportInput> = {}) {
  return h.service.submitReport(input(reported, { reason, ...o }));
}

describe("matchmaking hooks", () => {
  test("admitReport: one report per room per reporter, 5 per hour per device, 30 per hour per IP", async () => {
    h = harness();
    const dev = randomUUID();
    const room = randomUUID();
    expect(await h.service.admitReport(dev, room, null)).toBe("ok");
    expect(await h.service.admitReport(dev, room, null)).toBe("duplicate");
    for (let i = 0; i < 3; i++) expect(await h.service.admitReport(dev, randomUUID(), null)).toBe("ok");
    expect(await h.service.admitReport(dev, randomUUID(), null)).toBe("rate_limited");
    expect(await h.service.admitReport(randomUUID(), room, null)).toBe("ok");
    // Fresh device ids on one address share the per-IP budget; another address is unaffected.
    const ip = "203.0.113.7";
    for (let i = 0; i < 30; i++) expect(await h.service.admitReport(randomUUID(), randomUUID(), ip)).toBe("ok");
    expect(await h.service.admitReport(randomUUID(), randomUUID(), ip)).toBe("rate_limited");
    expect(await h.service.admitReport(randomUUID(), randomUUID(), "203.0.113.8")).toBe("ok");
  });

  test("roomEnded keeps the room for late reports and counts completed calls", async () => {
    h = harness();
    const [a, b] = [randomUUID(), randomUUID()];
    const roomId = randomUUID();
    await h.service.roomEnded({ roomId, devices: [a, b], activeSince: h.clock.now - 40_000, endedAt: h.clock.now });
    await h.service.roomEnded({ roomId: randomUUID(), devices: [a, b], activeSince: h.clock.now - 5_000, endedAt: h.clock.now });
    await h.service.roomEnded({ roomId: randomUUID(), devices: [a, b], activeSince: null, endedAt: h.clock.now });
    expect(await h.service.lastRoom(roomId)).toMatchObject({ roomId, devices: [a, b] });
    expect((await h.store.getFields(`dev:${a}`)).completedCalls).toBe(1);
    expect((await h.store.getFields(`dev:${b}`)).completedCalls).toBe(1);
  });
});

describe("weighted reports", () => {
  test("three fresh devices cannot pause anyone (sybil test)", async () => {
    h = harness();
    const target = randomUUID();
    for (let i = 0; i < 3; i++) expect((await report(target, "harassment")).restriction).toBeNull();
    expect(await h.service.activeForDevice(target)).toBeNull();
    expect(h.sink.applied).toEqual([]);
  });

  test("two established reporters cause a 10 min pause, never more", async () => {
    h = harness();
    const target = randomUUID();
    expect((await report(target, "harassment", { reporterDevice: await establishedDevice() })).restriction).toBeNull();
    const second = await report(target, "hate", { reporterDevice: await establishedDevice() });
    expect(second.restriction).toMatchObject({ kind: "pause", reason: "hate", until: h.clock.now + AUTO_PAUSE_MS });
    expect(h.sink.applied).toHaveLength(1);
    expect(h.sink.applied[0]!.deviceId).toBe(target);
    expect((await h.service.activeForDevice(target))!.id).toBe(second.restriction!.id);
    // Further reports while paused do not stack.
    expect((await report(target, "hate", { reporterDevice: await establishedDevice() })).restriction).toBeNull();
    // Logged as an automatic action.
    expect((await h.service.listAudit(10)).map((e) => e.action)).toContain("auto.pause");
  });

  test("the same reporter twice counts once, and short calls count half", async () => {
    h = harness();
    const target = randomUUID();
    const r = await establishedDevice();
    await report(target, "spam", { reporterDevice: r });
    expect((await report(target, "spam", { reporterDevice: r })).restriction).toBeNull();
    // A second established reporter on a call that never connected adds only half.
    expect((await report(target, "spam", { reporterDevice: await establishedDevice(), activeSince: null })).restriction).toBeNull();
  });

  test("after an automatic pause, only newer reports count toward the next one", async () => {
    h = harness();
    const target = randomUUID();
    await report(target, "spam", { reporterDevice: await establishedDevice() });
    expect((await report(target, "spam", { reporterDevice: await establishedDevice() })).restriction).not.toBeNull();
    h.clock.now += AUTO_PAUSE_MS + 1;
    expect(await h.service.activeForDevice(target)).toBeNull();
    expect((await report(target, "spam", { reporterDevice: await establishedDevice() })).restriction).toBeNull();
  });

  test("fresh device ids on one address count as one reporter; the same ids on distinct addresses pause", async () => {
    h = harness();
    const sybil = randomUUID();
    // Enough fresh devices to cross the threshold if each counted (about 0.23 each, threshold 1.6).
    for (let i = 0; i < 12; i++) {
      expect((await report(sybil, "harassment", { reporterIp: "203.0.113.20" })).restriction).toBeNull();
    }
    expect(await h.service.activeForDevice(sybil)).toBeNull();
    // The same addresses of one IPv6 /64 are one subscriber too.
    for (let i = 0; i < 12; i++) {
      expect((await report(sybil, "harassment", { reporterIp: `2001:db8:1:2::${i + 1}` })).restriction).toBeNull();
    }
    expect(await h.service.activeForDevice(sybil)).toBeNull();
    const stored = await h.store.get<StoredReport>("report", (await report(sybil, "spam", { reporterIp: "203.0.113.20" })).reportId);
    expect(stored!.reporterNetwork).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(stored)).not.toContain("203.0.113.20");

    const target = randomUUID();
    let paused = false;
    for (let i = 0; i < 12 && !paused; i++) {
      paused = (await report(target, "harassment", { reporterIp: `203.0.113.${30 + i}` })).restriction !== null;
    }
    expect(paused).toBe(true);
  });
});

describe("underage reports", () => {
  test("an uncorroborated report from a fresh device pauses nobody but routes to the restricted path", async () => {
    h = harness();
    const target = randomUUID();
    const res = await report(target, "underage", { frame: parseEvidenceFrame(jpegDataUrl()) });
    expect(res.restriction).toBeNull();
    const stored = (await h.store.get<StoredReport>("report", res.reportId))!;
    expect(stored.restricted).toBe(true);
    expect(await h.evidence.inner.get(stored.evidenceId!, { restricted: true })).not.toBeNull();
    expect(await h.evidence.inner.get(stored.evidenceId!, { restricted: false })).toBeNull();
  });

  test("a second independent device corroborates", async () => {
    h = harness();
    const target = randomUUID();
    await report(target, "underage");
    const second = await report(target, "underage");
    expect(second.restriction).toMatchObject({ reason: "underage", kind: "pause", evidenceAvailable: false });
    expect(second.restriction!.until).toBe(h.clock.now + AUTO_PAUSE_MS);
  });

  test("the same device twice does not corroborate itself", async () => {
    h = harness();
    const target = randomUUID();
    const reporter = randomUUID();
    await report(target, "underage", { reporterDevice: reporter });
    expect((await report(target, "underage", { reporterDevice: reporter })).restriction).toBeNull();
  });

  test("a second device on the same address does not corroborate", async () => {
    h = harness();
    const target = randomUUID();
    await report(target, "underage", { reporterIp: "203.0.113.40" });
    expect((await report(target, "underage", { reporterIp: "203.0.113.40" })).restriction).toBeNull();
    expect((await report(target, "underage", { reporterIp: "203.0.113.41" })).restriction).not.toBeNull();
  });

  test("a high-weight reporter or a prior minor flag corroborates", async () => {
    h = harness();
    const a = randomUUID();
    expect((await report(a, "underage", { reporterDevice: await establishedDevice() })).restriction).not.toBeNull();
    const b = randomUUID();
    await h.service.flagMinorRisk(b);
    expect((await report(b, "underage")).restriction).not.toBeNull();
  });
});

describe("CSAM routing", () => {
  test("nudity with a minor signal, or a frame the classifier flags as NSFW and possibly a minor", async () => {
    h = harness({
      classifier: async (bytes) => (bytes.length > 3_000 ? { nsfw: 0.95, minor: 0.8 } : { nsfw: 0.1, minor: 0.1 }),
    });
    const flagged = randomUUID();
    await h.service.flagMinorRisk(flagged);
    const nudity = await report(flagged, "nudity");
    expect((await h.store.get<StoredReport>("report", nudity.reportId))!.restricted).toBe(true);

    const spam = await report(randomUUID(), "spam", { frame: parseEvidenceFrame(jpegDataUrl(4_000)) });
    const stored = (await h.store.get<StoredReport>("report", spam.reportId))!;
    expect(stored.restricted).toBe(true);
    expect(stored.nsfwScore).toBe(0.95);

    const plain = await report(randomUUID(), "nudity", { frame: parseEvidenceFrame(jpegDataUrl(1_000)) });
    expect((await h.store.get<StoredReport>("report", plain.reportId))!.restricted).toBe(false);
  });

  test("a failing evidence store keeps the report, without the frame or its hash", async () => {
    h = harness();
    h.evidence.put = async () => {
      throw new Error("EACCES");
    };
    const frame = parseEvidenceFrame(jpegDataUrl())!;
    const res = await report(randomUUID(), "harassment", { frame });
    const stored = (await h.store.get<StoredReport>("report", res.reportId))!;
    expect(stored).toMatchObject({ evidenceId: null, evidenceSha256: null, reason: "harassment" });
  });

  test("a classifier that throws is ignored", async () => {
    h = harness({
      classifier: async () => {
        throw new Error("model missing");
      },
    });
    const res = await report(randomUUID(), "nudity", { frame: parseEvidenceFrame(jpegDataUrl()) });
    expect((await h.store.get<StoredReport>("report", res.reportId))!.nsfwScore).toBeNull();
  });

  test("escalation builds the packet from metadata without reading the image, freezes it and bans", async () => {
    h = harness();
    const target = randomUUID();
    await h.service.noteDeviceNetwork(target, "203.0.113.50", "US");
    const frame = parseEvidenceFrame(jpegDataUrl())!;
    const res = await report(target, "underage", {
      frame,
      chat: [{ from: "partner", text: "hi", ts: 1 }],
    });
    h.evidence.reads = [];
    const escalated = await h.service.escalate(res.reportId, actor, "filed");
    expect(escalated.ok).toBe(true);
    if (!escalated.ok) return;
    const { packet, restriction } = escalated.value;
    expect(h.evidence.reads).toEqual([]);
    expect(packet).toMatchObject({
      reportId: res.reportId,
      reason: "underage",
      humanViewed: false,
      reportedIpAddress: "203.0.113.50",
      reportedCountry: "US",
      evidenceSha256: frame.sha256,
      evidencePreservedUntil: h.clock.now + YEAR,
      chat: [{ from: "reported", text: "hi", ts: 1 }],
    });
    expect(packet.reportedDevice).toBe(h.service.pseudonym(target));
    expect(packet.reportedDevice).not.toContain(target);
    expect(restriction).toMatchObject({ reason: "minor-safety", kind: "ban", until: null, evidenceAvailable: false });
    const stored = (await h.store.get<StoredReport>("report", res.reportId))!;
    expect(stored).toMatchObject({ status: "escalated", legalHold: true });
    expect((await h.service.listAudit(5))[0]).toMatchObject({ action: "report.escalate_csam", note: "filed", ip: actor.ip });

    // Escalating again does not stack bans.
    const again = await h.service.escalate(res.reportId, actor);
    expect(again.ok && again.value.restriction).toBeNull();
  });

  test("escalating a general report moves its evidence to the restricted path", async () => {
    h = harness();
    const res = await report(randomUUID(), "harassment", { frame: parseEvidenceFrame(jpegDataUrl()) });
    const id = (await h.store.get<StoredReport>("report", res.reportId))!.evidenceId!;
    await h.service.escalate(res.reportId, actor);
    expect(await h.evidence.inner.get(id, { restricted: false })).toBeNull();
    expect(await h.evidence.inner.get(id, { restricted: true })).not.toBeNull();
    expect((await h.service.evidenceImage(res.reportId, actor)).ok).toBe(false);
  });
});

describe("admin review", () => {
  test("the queue is sorted by severity, then by due clock, and hides raw device ids", async () => {
    h = harness();
    const target = randomUUID();
    const spam = await report(target, "spam");
    h.clock.now += 1000;
    const nudity = await report(target, "nudity");
    h.clock.now += 1000;
    const minor = await report(target, "underage");
    h.clock.now += 1000;
    const hate = await report(target, "hate");
    const queue = await h.service.queue();
    expect(queue.map((r) => r.id)).toEqual([minor.reportId, nudity.reportId, hate.reportId, spam.reportId]);
    expect(queue[0]).toMatchObject({ severity: "critical", restricted: true, priorReportsAgainst: 2 });
    expect(queue[3]!.resolveDueAt - queue[3]!.createdAt).toBe(15 * DAY);
    expect(JSON.stringify(queue)).not.toContain(target);
  });

  test("the open queue is capped at ADMIN_LIST_LIMIT, oldest first", async () => {
    h = harness();
    const first = await report(randomUUID(), "spam");
    for (let i = 0; i < ADMIN_LIST_LIMIT; i++) {
      h.clock.now += 1;
      await report(randomUUID(), "spam");
    }
    const queue = await h.service.queue();
    expect(queue).toHaveLength(ADMIN_LIST_LIMIT);
    expect(queue[0]!.id).toBe(first.reportId);
    expect((await h.service.queue("all")).length).toBe(ADMIN_LIST_LIMIT);
  });

  test("evidence access is audited and marks the report as viewed; restricted access is refused and audited", async () => {
    h = harness();
    const res = await report(randomUUID(), "harassment", { frame: parseEvidenceFrame(jpegDataUrl()) });
    const image = await h.service.evidenceImage(res.reportId, actor);
    expect(image.ok).toBe(true);
    expect((await h.store.get<StoredReport>("report", res.reportId))!.humanViewed).toBe(true);
    const restricted = await report(randomUUID(), "underage", { frame: parseEvidenceFrame(jpegDataUrl()) });
    expect(await h.service.evidenceImage(restricted.reportId, actor)).toEqual({ ok: false, error: "restricted" });
    const actions = (await h.service.listAudit(10)).map((e) => e.action);
    expect(actions).toContain("report.view_evidence");
    expect(actions).toContain("report.evidence_denied");
  });

  test("the ladder: warning, 10 min, 24 h, 7 days, permanent", async () => {
    h = harness();
    const target = randomUUID();
    const steps: (number | null)[] = [];
    const warn = await h.service.actOnReport((await report(target, "spam")).reportId, { action: "warn" }, actor);
    expect(warn.ok && warn.value.restriction).toMatchObject({ kind: "warning", reason: "spam" });
    for (let i = 0; i < 4; i++) {
      const res = await h.service.actOnReport((await report(target, "spam")).reportId, { action: "restrict" }, actor);
      if (!res.ok) throw new Error("action failed");
      const r = res.value.restriction!;
      steps.push(r.until === null ? null : r.until - r.createdAt);
    }
    expect(steps).toEqual([10 * MINUTE, DAY, 7 * DAY, null]);
    // A warning does not block matching; the sink still hears about it.
    expect(h.sink.applied[0]!.restriction.kind).toBe("warning");
    expect((await h.service.activeForDevice(target))!.until).toBeNull();
  });

  test("an explicit duration overrides the ladder, and automatic pauses do not count on it", async () => {
    h = harness();
    const target = randomUUID();
    await report(target, "spam", { reporterDevice: await establishedDevice() });
    await report(target, "spam", { reporterDevice: await establishedDevice() }); // auto pause
    const res = await h.service.actOnReport((await report(target, "spam")).reportId, { action: "restrict" }, actor);
    expect(res.ok && res.value.restriction!.until! - res.value.restriction!.createdAt).toBe(10 * MINUTE);
    const custom = await h.service.actOnReport(
      (await report(target, "spam")).reportId,
      { action: "restrict", durationMs: RESTRICTION_DURATIONS_MS[2], reason: "fake-video" },
      actor,
    );
    expect(custom.ok && custom.value.restriction).toMatchObject({ kind: "ban", reason: "fake-video" });
  });

  test("dismissing lifts the automatic pause it caused and lowers the reporter's weight", async () => {
    h = harness();
    const target = randomUUID();
    const reporter = await establishedDevice();
    await report(target, "spam", { reporterDevice: await establishedDevice() });
    const res = await report(target, "spam", { reporterDevice: reporter });
    expect(res.restriction).not.toBeNull();
    const dismissed = await h.service.actOnReport(res.reportId, { action: "dismiss", note: "no issue" }, actor);
    expect(dismissed.ok && dismissed.value.report.status).toBe("dismissed");
    expect(await h.service.activeForDevice(target)).toBeNull();
    expect(h.sink.lifted).toEqual([{ deviceId: target, remaining: null }]);
    expect((await h.store.getFields(`dev:${reporter}`)).dismissed).toBe(1);
    // Deciding again does not count twice.
    await h.service.actOnReport(res.reportId, { action: "dismiss" }, actor);
    expect((await h.store.getFields(`dev:${reporter}`)).dismissed).toBe(1);
    expect((await h.service.queue()).map((r) => r.id)).not.toContain(res.reportId);
  });

  test("acknowledge only from open; unknown ids are not found", async () => {
    h = harness();
    const res = await report(randomUUID(), "spam");
    const ack = await h.service.actOnReport(res.reportId, { action: "acknowledge" }, actor);
    expect(ack.ok && ack.value.report.status).toBe("acknowledged");
    expect(await h.service.actOnReport(res.reportId, { action: "acknowledge" }, actor)).toEqual({ ok: false, error: "conflict" });
    expect(await h.service.actOnReport(randomUUID(), { action: "warn" }, actor)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("restrictions, fingerprints and appeals", () => {
  async function restricted(reason: ReportReason = "harassment", withFrame = true) {
    const device = randomUUID();
    const res = await report(device, reason, withFrame ? { frame: parseEvidenceFrame(jpegDataUrl()) } : {});
    const act = await h.service.actOnReport(res.reportId, { action: "restrict" }, actor);
    if (!act.ok) throw new Error("restrict failed");
    return { device, restriction: act.value.restriction! };
  }

  test("the restricted device sees its restriction and the evidence frame, nobody else does", async () => {
    h = harness();
    const { device, restriction } = await restricted();
    const view = await h.service.restrictionView(restriction.id, device);
    expect(view!.restriction.evidenceAvailable).toBe(true);
    expect(view!.evidenceFrame).toStartWith("data:image/jpeg;base64,");
    expect(await h.service.restrictionView(restriction.id, randomUUID())).toBeNull();
  });

  test("no evidence frame for nudity", async () => {
    h = harness();
    const { device, restriction } = await restricted("nudity");
    const view = await h.service.restrictionView(restriction.id, device);
    expect(view).toMatchObject({ restriction: { evidenceAvailable: false }, evidenceFrame: null });
  });

  test("a fingerprint carries a restriction to a new device id", async () => {
    h = harness();
    const fp = createHash("sha256").update("browser").digest("hex");
    const device = randomUUID();
    expect(await h.service.activeForDevice(device, fp)).toBeNull(); // links device and fingerprint
    const res = await report(device, "spam");
    await h.service.actOnReport(res.reportId, { action: "restrict", durationMs: RESTRICTION_DURATIONS_MS[1] }, actor);
    const fresh = randomUUID();
    const found = await h.service.activeForDevice(fresh, fp);
    expect(found).not.toBeNull();
    expect(await h.service.restrictionView(found!.id, fresh)).not.toBeNull();
    expect(await h.service.activeForDevice(randomUUID())).toBeNull();
  });

  test("one appeal per restriction; overturning lifts it", async () => {
    h = harness();
    const { device, restriction } = await restricted();
    const text = "This was a misunderstanding, please review.";
    expect(await h.service.submitAppeal({ restrictionId: restriction.id, deviceId: randomUUID(), text }, null)).toEqual({
      ok: false,
      error: "not_found",
    });
    const appeal = await h.service.submitAppeal({ restrictionId: restriction.id, deviceId: device, text }, "203.0.113.1");
    expect(appeal.ok).toBe(true);
    expect(await h.service.submitAppeal({ restrictionId: restriction.id, deviceId: device, text }, "203.0.113.1")).toEqual({
      ok: false,
      error: "already_appealed",
    });
    const listed = await h.service.listAppeals();
    expect(listed[0]).toMatchObject({ status: "pending", restriction: { appeal: { status: "pending" } } });
    expect(listed[0]!.dueAt - listed[0]!.createdAt).toBe(2 * DAY);

    h.clock.now += 1;
    const decided = await h.service.decideAppeal(listed[0]!.id, "overturn", "error", actor);
    expect(decided.ok && decided.value.restriction.appeal.status).toBe("overturned");
    expect(await h.service.activeForDevice(device)).toBeNull();
    expect(h.sink.lifted.at(-1)).toEqual({ deviceId: device, remaining: null });
    expect(await h.service.decideAppeal(listed[0]!.id, "uphold", undefined, actor)).toEqual({ ok: false, error: "conflict" });
    expect((await h.service.listAudit(1))[0]!.action).toBe("appeal.overturn");
  });

  test("upholding keeps the restriction; the per-device appeal quota counts only the device's own restrictions", async () => {
    h = harness();
    const { device, restriction } = await restricted("spam", false);
    const text = "Please take another look at this.";
    // Guessed restriction ids (anyone can send a victim's deviceId) must not burn the victim's quota.
    for (let i = 0; i < 5; i++) {
      expect(await h.service.submitAppeal({ restrictionId: randomUUID(), deviceId: device, text }, null)).toEqual({ ok: false, error: "not_found" });
    }
    const appeal = await h.service.submitAppeal({ restrictionId: restriction.id, deviceId: device, text }, null);
    if (!appeal.ok) throw new Error("appeal failed");
    await h.service.decideAppeal(appeal.appealId, "uphold", undefined, actor);
    expect(await h.service.activeForDevice(device)).not.toBeNull();
    // Further restrictions on the same device: the quota holds for its own appeals.
    for (let i = 0; i < 4; i++) {
      const res = await report(device, "spam");
      const act = await h.service.actOnReport(res.reportId, { action: "restrict" }, actor);
      if (!act.ok) throw new Error("restrict failed");
      expect((await h.service.submitAppeal({ restrictionId: act.value.restriction!.id, deviceId: device, text }, null)).ok).toBe(true);
    }
    const res = await report(device, "spam");
    const act = await h.service.actOnReport(res.reportId, { action: "restrict" }, actor);
    if (!act.ok) throw new Error("restrict failed");
    expect(await h.service.submitAppeal({ restrictionId: act.value.restriction!.id, deviceId: device, text }, null)).toEqual({
      ok: false,
      error: "rate_limited",
    });
  });

  test("appeals are rate limited per IP across devices", async () => {
    h = harness();
    const text = "Please take another look at this.";
    const ip = "203.0.113.7";
    for (let i = 0; i < APPEALS_PER_IP_PER_HOUR; i++) {
      const res = await h.service.submitAppeal({ restrictionId: randomUUID(), deviceId: randomUUID(), text }, ip);
      expect(res).toEqual({ ok: false, error: "not_found" });
    }
    expect(await h.service.submitAppeal({ restrictionId: randomUUID(), deviceId: randomUUID(), text }, ip)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    // Another IP is unaffected.
    const other = await h.service.submitAppeal({ restrictionId: randomUUID(), deviceId: randomUUID(), text }, "203.0.113.8");
    expect(other).toEqual({ ok: false, error: "not_found" });
  });
});

describe("takedowns", () => {
  const body = {
    kind: "ncii" as const,
    contactEmail: "person@example.com",
    description: "An intimate image of me was captured during a call.",
    isAffectedPerson: true,
    goodFaithStatement: true as const,
    turnstileToken: "tok",
  };

  test("tickets carry their legal clock; a failed Turnstile check creates nothing", async () => {
    h = harness({ turnstile: async (t) => t === "tok" });
    expect(await h.service.submitTakedown({ ...body, turnstileToken: "bad" }, null)).toEqual({
      ok: false,
      error: "turnstile_failed",
    });
    const ncii = await h.service.submitTakedown(body, null);
    const csam = await h.service.submitTakedown({ ...body, kind: "csam" }, null);
    expect(ncii.ok && csam.ok).toBe(true);
    const list = await h.service.listTakedowns();
    expect(list.map((t) => t.dueAt - t.createdAt)).toEqual([DAY, 2 * DAY]);
    expect(list[0]).not.toHaveProperty("restricted");
    const resolved = await h.service.resolveTakedown(list[1]!.id, "Frame deleted.", actor);
    expect(resolved.ok && resolved.value.status).toBe("resolved");
    expect(await h.service.resolveTakedown(list[1]!.id, "again", actor)).toEqual({ ok: false, error: "conflict" });
  });

  test("rate limited per IP", async () => {
    h = harness();
    for (let i = 0; i < 5; i++) expect((await h.service.submitTakedown(body, "203.0.113.2")).ok).toBe(true);
    expect(await h.service.submitTakedown(body, "203.0.113.2")).toEqual({ ok: false, error: "rate_limited" });
  });
});

describe("retention sweep", () => {
  test("deletes year-old reports and evidence, keeps legal holds, expires ended restrictions a year later", async () => {
    h = harness();
    const start = h.clock.now;
    const old = await report(randomUUID(), "spam", { frame: parseEvidenceFrame(jpegDataUrl()) });
    const oldEvidence = (await h.store.get<StoredReport>("report", old.reportId))!.evidenceId!;
    const held = await report(randomUUID(), "underage", { frame: parseEvidenceFrame(jpegDataUrl()) });
    await h.service.escalate(held.reportId, actor);
    const short = await h.service.actOnReport((await report(randomUUID(), "spam")).reportId, { action: "restrict" }, actor);
    const shortId = short.ok ? short.value.restriction!.id : "";
    const appeal = await h.service.submitAppeal(
      { restrictionId: shortId, deviceId: (await h.store.get<StoredRestriction>("restriction", shortId))!.deviceId, text: "please review this" },
      null,
    );
    const takedown = await h.service.submitTakedown(
      { kind: "other", contactEmail: "a@example.com", description: "x".repeat(30), isAffectedPerson: false, goodFaithStatement: true },
      null,
    );
    if (!takedown.ok || !appeal.ok) throw new Error("setup failed");
    await h.service.resolveTakedown(takedown.ticketId, "done", actor);

    h.clock.now = start + YEAR - DAY;
    expect(await h.service.sweepRetention()).toEqual({ reports: 0, restrictions: 0, appeals: 0, takedowns: 0 });

    h.clock.now = start + YEAR + 11 * MINUTE;
    const counts = await h.service.sweepRetention();
    expect(counts.reports).toBe(2); // the spam report and the one behind the 10 min restriction; the escalated one is on hold
    expect(counts.restrictions).toBe(1); // the 10 min one; the permanent CSAM ban stays
    expect(counts.appeals).toBe(1);
    expect(counts.takedowns).toBe(1);
    expect(await h.store.get("report", old.reportId)).toBeNull();
    expect(await h.evidence.inner.get(oldEvidence, { restricted: false })).toBeNull();
    expect(await h.store.get("report", held.reportId)).not.toBeNull();
    expect(await h.store.get("restriction", shortId)).toBeNull();
    expect(await h.service.sweepRetention()).toEqual({ reports: 0, restrictions: 0, appeals: 0, takedowns: 0 });
  });
});
