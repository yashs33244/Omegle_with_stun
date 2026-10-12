/**
 * Reports, restrictions, appeals, takedowns, CSAM escalation, the audit log
 * and retention. Matchmaking calls the hooks at the top (MatchService);
 * the public and admin HTTP routers call the rest.
 *
 * Rules (BUILD_V1 item 6, LAUNCH_PLAN LB-4/LB-5):
 * - Evidence is attacker-controlled and never triggers a penalty on its own.
 * - The only automatic action is a 10 min pause, when the weighted reports
 *   against a device cross a threshold, or for an underage report that is
 *   corroborated. Everything longer is a human decision on the ladder.
 * - Suspected CSAM is routed to the restricted evidence path, never served to
 *   the console, and never shown back to the restricted user.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { Logger } from "../logger";
import { ipBuckets } from "../session/geo";
import type {
  AdminAppeal,
  AdminAuditEntry,
  AdminReport,
  AdminReportAction,
  AdminTakedown,
  AppealRequest,
  AppealResponse,
  CsamReportPacket,
  ReportReason,
  Restriction,
  RestrictionReason,
  RestrictionView,
  TakedownRequest,
  TakedownResponse,
} from "../protocol";
import { toDataUrl, type EvidenceFrame, type EvidenceStore } from "./evidence";
import {
  ADMIN_ERRORS,
  ADMIN_IDEMPOTENCY_TTL_MS,
  ADMIN_LIST_LIMIT,
  ADMIT_RESULTS,
  APPEALS_PER_DEVICE_PER_DAY,
  APPEALS_PER_IP_PER_HOUR,
  APPEAL_CLAIM_TTL_MS,
  APPEAL_DUE_MS,
  AUDIT_ACTION,
  AUTO_PAUSE_MS,
  AUTO_PAUSE_THRESHOLD,
  AUTO_PAUSE_WINDOW_MS,
  COMPLETED_CALL_MS,
  CSAM_PRESERVE_MS,
  DAY,
  DEFAULT_REPORT_AFTER_END_MS,
  DEVICE_FIELD,
  DEVICE_TTL_MS,
  FINGERPRINT_TTL_MS,
  HIGH_WEIGHT,
  HOUR,
  INDEX,
  KEY,
  LAST_ROOM_GRACE_MS,
  NETWORK_BAN_TTL_MS,
  NETWORK_TTL_MS,
  PERMANENT_SCORE,
  PSEUDONYM_HEX_CHARS,
  REPORTS_PER_HOUR,
  REPORTS_PER_IP_PER_HOUR,
  RETENTION_CHECK_INTERVAL_MS,
  RETENTION_MS,
  SHORT_CALL_MS,
  TAKEDOWNS_PER_IP_PER_HOUR,
  UNDERAGE_CORROBORATION_WINDOW_MS,
  WARNING_STEP,
  type LadderStep,
} from "./constants";
import {
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
  type FrameClassifier,
  type FrameScores,
} from "./policy";
import type { EnforcementStore } from "./EnforcementStore";
import type { TurnstileVerifier } from "./turnstile";
import type {
  DeviceNetwork,
  DeviceStats,
  LastRoom,
  NetworkBan,
  StoredAppeal,
  StoredReport,
  StoredRestriction,
  StoredTakedown,
} from "./types";

/** Matchmaking side effects of a restriction (implemented by MatchService). */
export interface RestrictionSink {
  /** Blocks matching while active, ends any room of the device and emits session:restricted. */
  restrictionApplied(deviceId: string, restriction: Restriction): Promise<void>;
  /** A restriction was lifted early; `remaining` is the device's other active restriction, if any. */
  restrictionLifted(deviceId: string, remaining: Restriction | null): Promise<void>;
}

/** Who performed an admin action, for the audit log. */
export interface Actor {
  ip: string | null;
}

export interface EnforcementDeps {
  store: EnforcementStore;
  evidence: EvidenceStore;
  logger: Logger;
  turnstile: TurnstileVerifier;
  /** Salt for the pseudonymous device ids shown to admins. Keep it stable across restarts. */
  pseudonymSalt: string;
  /** Reports are accepted this long after a room ended. */
  reportAfterEndMs?: number;
  classifier?: FrameClassifier;
  now?: () => number;
}

export interface ReportInput {
  roomId: string;
  reporterDevice: string;
  /** The reporter's client IP, if known. Only a salted hash of its subscriber bucket is stored. */
  reporterIp: string | null;
  reportedDevice: string;
  reason: ReportReason;
  details?: string;
  frame: EvidenceFrame | null;
  chat?: { from: "me" | "partner"; text: string; ts: number }[];
  /** When the call became active, if it did. */
  activeSince: number | null;
  /** When the room ended if the report came after the call. */
  endedAt: number | null;
}

export type AdmitResult = (typeof ADMIT_RESULTS)[number];

export type AdminError = (typeof ADMIN_ERRORS)[number];
export type AdminResult<T> = { ok: true; value: T } | { ok: false; error: AdminError };

const ok = <T>(value: T): AdminResult<T> => ({ ok: true, value });
const fail = <T>(error: AdminError): AdminResult<T> => ({ ok: false, error });

function toPublic(r: StoredRestriction): Restriction {
  return {
    id: r.id,
    reason: r.reason,
    kind: r.kind,
    until: r.until,
    createdAt: r.createdAt,
    evidenceAvailable: r.evidenceAvailable,
    appeal: r.appeal,
    appealable: r.appealable,
  };
}

function isActive(r: StoredRestriction, now: number): boolean {
  return r.kind !== WARNING_STEP && r.liftedAt === null && (r.until === null || r.until > now);
}

/** Permanent first, then the latest end. */
function strongest(list: StoredRestriction[]): StoredRestriction | null {
  let best: StoredRestriction | null = null;
  for (const r of list) {
    if (!best || r.until === null || (best.until !== null && r.until > best.until)) best = r;
    if (best.until === null) break;
  }
  return best;
}

/** Collection score for retention: when the restriction stopped mattering. */
function restrictionEnd(r: StoredRestriction): number {
  return r.liftedAt ?? r.until ?? PERMANENT_SCORE;
}

/** One reporter, for counting distinct reporters: the network hash when known, else the device. */
function reporterKey(r: StoredReport): string {
  return r.reporterNetwork ?? r.reporterDevice;
}

export class EnforcementService {
  private readonly store: EnforcementStore;
  private readonly evidence: EvidenceStore;
  private readonly log: Logger;
  private readonly turnstile: TurnstileVerifier;
  private readonly classifier?: FrameClassifier;
  private readonly salt: string;
  readonly reportAfterEndMs: number;
  private readonly now: () => number;
  private sink?: RestrictionSink;
  private timer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<unknown>;

  constructor(deps: EnforcementDeps) {
    this.store = deps.store;
    this.evidence = deps.evidence;
    this.log = deps.logger;
    this.turnstile = deps.turnstile;
    this.classifier = deps.classifier;
    this.salt = deps.pseudonymSalt;
    this.reportAfterEndMs = deps.reportAfterEndMs ?? DEFAULT_REPORT_AFTER_END_MS;
    this.now = deps.now ?? Date.now;
  }

  setSink(sink: RestrictionSink): void {
    this.sink = sink;
  }

  /** Stable pseudonym for admin views and packets: never the raw device id. */
  pseudonym(deviceId: string): string {
    return createHmac("sha256", this.salt).update(deviceId).digest("hex").slice(0, PSEUDONYM_HEX_CHARS);
  }

  /**
   * Salted hash of the address's bucket (the /64 for IPv6): the key for every
   * per-IP counter and the stored reporterNetwork, so no raw address is kept.
   */
  network(ip: string): string {
    return this.pseudonym(ipBuckets(ip).ip);
  }

  /* ---------------------------------------------------------------- */
  /* Matchmaking hooks                                                 */
  /* ---------------------------------------------------------------- */

  /** session:hello: remembers when the device was first seen (reporter weight). */
  async noteDeviceSeen(deviceId: string): Promise<void> {
    await this.store.setFieldIfAbsent(KEY.device(deviceId), DEVICE_FIELD.firstSeen, this.now(), DEVICE_TTL_MS);
  }

  /**
   * Network facts for CSAM packets, kept 24 h; a ban placed meanwhile is also
   * carried to the address (banNetwork). The session lane calls this when it
   * creates a session (it sees the client IP and the Cloudflare country).
   */
  async noteDeviceNetwork(deviceId: string, ip: string | null, country: string | null): Promise<void> {
    const net: DeviceNetwork = { ip, country };
    await this.store.setValue(KEY.network(deviceId), net, NETWORK_TTL_MS);
  }

  /** Risk signal from elsewhere (age signal, reviewer): corroborates underage reports. */
  async flagMinorRisk(deviceId: string): Promise<void> {
    await this.store.incrField(KEY.device(deviceId), DEVICE_FIELD.minorFlag, 1, DEVICE_TTL_MS);
  }

  /** Called for every room that ends. Keeps the room briefly for late reports and counts completed calls. */
  async roomEnded(room: { roomId: string; devices: [string, string]; activeSince: number | null; endedAt: number }) {
    const last: LastRoom = { ...room };
    await this.store.setValue(KEY.lastRoom(room.roomId), last, this.reportAfterEndMs + LAST_ROOM_GRACE_MS);
    if (room.activeSince !== null && room.endedAt - room.activeSince >= COMPLETED_CALL_MS) {
      for (const d of room.devices) {
        await this.store.incrField(KEY.device(d), DEVICE_FIELD.completedCalls, 1, DEVICE_TTL_MS);
      }
    }
  }

  lastRoom(roomId: string): Promise<LastRoom | null> {
    return this.store.getValue<LastRoom>(KEY.lastRoom(roomId));
  }

  /**
   * Rate limits (REPORTS_PER_HOUR per device, REPORTS_PER_IP_PER_HOUR per client
   * network when known) and one report per room per reporter.
   */
  async admitReport(reporterDevice: string, roomId: string, ip: string | null): Promise<AdmitResult> {
    if ((await this.store.hit(KEY.reportRate(reporterDevice), HOUR)) > REPORTS_PER_HOUR) return "rate_limited";
    if (ip && (await this.store.hit(KEY.reportIpRate(this.network(ip)), HOUR)) > REPORTS_PER_IP_PER_HOUR) return "rate_limited";
    if (!(await this.store.claim(KEY.roomReport(roomId, reporterDevice), DAY))) return "duplicate";
    return "ok";
  }

  /**
   * The restriction that blocks this device now, or null. With a fingerprint it
   * remembers the device-fingerprint link (180 days); with or without one it
   * also checks restrictions recorded against the linked fingerprint, so a
   * restriction placed on another device of the same browser counts here too.
   */
  async activeForDevice(deviceId: string, fingerprintHash?: string | null): Promise<Restriction | null> {
    if (fingerprintHash) await this.store.setValue(KEY.fingerprint(deviceId), fingerprintHash, FINGERPRINT_TTL_MS);
    const fingerprint = fingerprintHash ?? (await this.store.getValue<string>(KEY.fingerprint(deviceId)));
    const ids = new Set(await this.store.indexRange(KEY.restrictions(deviceId)));
    if (fingerprint) {
      for (const id of await this.store.indexRange(KEY.restrictionsByFingerprint(fingerprint))) ids.add(id);
    }
    const found = await this.activeOf([...ids]);
    return found ? toPublic(found) : null;
  }

  /**
   * A ban recorded against this address (IPv4 address or IPv6 /64, by salted
   * hash) within NETWORK_BAN_TTL_MS, or null. Checked by POST /api/session so
   * a banned person cannot mint a fresh device id from the same connection.
   * Only `ban` restrictions are carried (restrict); a lifted ban stops
   * counting at once. The view is not the stranger's to appeal or to see
   * evidence of, and ends when the address is free again.
   */
  async activeForNetwork(ip: string): Promise<Restriction | null> {
    const mark = await this.store.getValue<NetworkBan>(KEY.networkBan(this.network(ip)));
    const now = this.now();
    if (!mark || mark.until <= now) return null;
    const r = await this.store.get<StoredRestriction>("restriction", mark.restrictionId);
    if (!r || r.kind !== "ban" || !isActive(r, now)) return null;
    return { ...toPublic(r), until: mark.until, evidenceAvailable: false, appealable: false };
  }

  private async activeOf(ids: string[]): Promise<StoredRestriction | null> {
    const now = this.now();
    const all = await this.store.getMany<StoredRestriction>("restriction", ids);
    return strongest(all.filter((r): r is StoredRestriction => r !== null && isActive(r, now)));
  }

  private async deviceStats(deviceId: string): Promise<DeviceStats> {
    const f = await this.store.getFields(KEY.device(deviceId));
    return {
      firstSeen: f.firstSeen ?? null,
      completedCalls: f.completedCalls ?? 0,
      upheld: f.upheld ?? 0,
      dismissed: f.dismissed ?? 0,
      minorFlag: (f.minorFlag ?? 0) > 0,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Reports                                                           */
  /* ---------------------------------------------------------------- */

  /** Stores the report (and evidence), then applies the automatic rules. */
  async submitReport(input: ReportInput): Promise<{ reportId: string; restriction: Restriction | null }> {
    const now = this.now();
    const id = randomUUID();
    const [reporterStats, reportedStats] = await Promise.all([
      this.deviceStats(input.reporterDevice),
      this.deviceStats(input.reportedDevice),
    ]);
    const weight = reporterWeight(reporterStats, now);
    const scores = input.frame ? await this.classify(input.frame) : null;
    // Reporters on one address count once toward automatic action; only a salted hash of the address is kept.
    const reporterNetwork = input.reporterIp ? this.network(input.reporterIp) : null;
    const otherUnderageReporters = await this.underageReporters(input.reportedDevice, reporterNetwork ?? input.reporterDevice, now);
    const minorSignal = reportedStats.minorFlag || otherUnderageReporters > 0;
    const restricted = routeRestricted({ reason: input.reason, scores, minorSignal });
    // Read before the frame is stored, so nothing can fail between storing it and saving the record.
    const reportedNetwork = restricted ? await this.store.getValue<DeviceNetwork>(KEY.network(input.reportedDevice)) : null;

    let evidenceId: string | null = null;
    if (input.frame) {
      // A storage failure must not lose the report itself: keep it without the frame (the hash stays).
      try {
        const id = randomUUID();
        await this.evidence.put(id, input.frame.bytes, { restricted });
        evidenceId = id;
      } catch (err) {
        this.log.error({ err, restricted }, "could not store report evidence");
      }
    }
    const end = input.endedAt ?? now;
    const report: StoredReport = {
      id,
      createdAt: now,
      roomId: input.roomId,
      reason: input.reason,
      reporterDevice: input.reporterDevice,
      reporterNetwork,
      reportedDevice: input.reportedDevice,
      reporterWeight: weight,
      details: input.details?.trim() || null,
      chat: (input.chat ?? []).map((l) => ({ from: l.from === "me" ? "reporter" : "reported", text: l.text, ts: l.ts })),
      evidenceId,
      evidenceSha256: evidenceId && input.frame ? input.frame.sha256 : null,
      restricted,
      nsfwScore: scores?.nsfw ?? null,
      minorScore: scores?.minor ?? null,
      status: "open",
      shortCall: input.activeSince === null || end - input.activeSince < SHORT_CALL_MS,
      humanViewed: false,
      legalHold: false,
      preservedUntil: null,
      acknowledgedAt: null,
      decidedAt: null,
      restrictionId: null,
      reportedNetwork,
    };
    try {
      await this.store.put("report", id, report, now);
    } catch (err) {
      // Without the record nothing would ever point at (or delete) the stored frame.
      if (evidenceId) {
        await this.evidence.delete(evidenceId, { restricted }).catch((cleanup: unknown) => {
          this.log.error({ err: cleanup, restricted }, "could not delete the evidence of an unsaved report");
        });
      }
      throw err;
    }
    await this.store.addToIndex(KEY.reportsAgainst(input.reportedDevice), id, now);
    await this.store.addToIndex(INDEX.openReports, id, now);
    this.log.info({ reportId: id, reason: input.reason, restricted }, "report stored");

    const restriction = await this.autoAction(report, reportedStats, otherUnderageReporters);
    return { reportId: id, restriction };
  }

  private async classify(frame: EvidenceFrame): Promise<FrameScores | null> {
    if (!this.classifier) return null;
    try {
      return await this.classifier(frame.bytes);
    } catch (err) {
      this.log.warn({ err }, "frame classifier failed");
      return null;
    }
  }

  /** Distinct OTHER reporters (by network, else device) that reported `deviceId` as underage recently. */
  private async underageReporters(deviceId: string, exclude: string, now: number): Promise<number> {
    const ids = await this.store.indexRange(KEY.reportsAgainst(deviceId), { min: now - UNDERAGE_CORROBORATION_WINDOW_MS });
    const reports = await this.store.getMany<StoredReport>("report", ids);
    const reporters = new Set<string>();
    for (const r of reports) {
      if (r && r.reason === "underage" && r.status !== "dismissed" && reporterKey(r) !== exclude) reporters.add(reporterKey(r));
    }
    return reporters.size;
  }

  /**
   * Report-driven automatic action, capped at a 10 min pause:
   * - underage: only when corroborated (a high-weight reporter, a second
   *   independent reporter, or a prior minor flag);
   * - otherwise: when the weighted reports from distinct reporters since the last
   *   automatic pause (within 24 h) reach the threshold. Reports from one network
   *   (reporterKey) count once, at their highest weight, so fresh device ids on
   *   one connection cannot stack up.
   */
  private async autoAction(
    report: StoredReport,
    reportedStats: DeviceStats,
    otherUnderageReporters: number,
  ): Promise<Restriction | null> {
    const device = report.reportedDevice;
    if (await this.activeForDevice(device)) return null;
    const now = report.createdAt;

    if (report.reason === "underage") {
      const corroborated = report.reporterWeight >= HIGH_WEIGHT || otherUnderageReporters > 0 || reportedStats.minorFlag;
      if (!corroborated) return null;
      return this.restrict({ deviceId: device, reason: "underage", step: AUTO_PAUSE_MS, auto: true, report });
    }

    const lastAuto = (await this.store.getValue<number>(KEY.lastAutoPause(device))) ?? 0;
    const since = Math.max(now - AUTO_PAUSE_WINDOW_MS, lastAuto + 1);
    const ids = await this.store.indexRange(KEY.reportsAgainst(device), { min: since });
    const reports = await this.store.getMany<StoredReport>("report", ids);
    const byReporter = new Map<string, number>();
    for (const r of reports) {
      if (!r || r.status === "dismissed") continue;
      const w = reportWeight(r.reporterWeight, r.shortCall);
      byReporter.set(reporterKey(r), Math.max(byReporter.get(reporterKey(r)) ?? 0, w));
    }
    const total = [...byReporter.values()].reduce((a, b) => a + b, 0);
    if (total < AUTO_PAUSE_THRESHOLD) return null;
    await this.store.setValue(KEY.lastAutoPause(device), now, AUTO_PAUSE_WINDOW_MS);
    return this.restrict({
      deviceId: device,
      reason: restrictionReasonFor(report.reason, report.restricted),
      step: AUTO_PAUSE_MS,
      auto: true,
      report,
    });
  }

  /** Creates a restriction, links it to its report and tells matchmaking. */
  private async restrict(p: {
    deviceId: string;
    reason: RestrictionReason;
    step: LadderStep;
    auto: boolean;
    report: StoredReport | null;
  }): Promise<Restriction> {
    const now = this.now();
    const warning = p.step === WARNING_STEP;
    const duration = warning ? 0 : (p.step as number | null);
    const r: StoredRestriction = {
      id: randomUUID(),
      reason: p.reason,
      kind: warning ? WARNING_STEP : kindFor(duration),
      until: warning ? now : duration === null ? null : now + duration,
      createdAt: now,
      evidenceAvailable: evidenceShowable(p.reason, Boolean(p.report?.evidenceId), Boolean(p.report?.restricted)),
      appeal: { status: "none" },
      appealable: true,
      deviceId: p.deviceId,
      fingerprintHash: await this.store.getValue<string>(KEY.fingerprint(p.deviceId)),
      reportId: p.report?.id ?? null,
      auto: p.auto,
      liftedAt: null,
    };
    await this.store.put("restriction", r.id, r, restrictionEnd(r));
    await this.store.addToIndex(KEY.restrictions(p.deviceId), r.id, now);
    if (r.fingerprintHash && !warning) {
      await this.store.addToIndex(KEY.restrictionsByFingerprint(r.fingerprintHash), r.id, now);
    }
    if (r.kind === "ban") await this.banNetwork(p.deviceId, r, now);
    if (p.report) {
      p.report.restrictionId = r.id;
      await this.store.put("report", p.report.id, p.report, p.report.createdAt);
    }
    if (p.reason === "underage" || p.reason === "minor-safety") {
      if (!p.auto) await this.flagMinorRisk(p.deviceId);
    }
    if (p.auto) {
      await this.audit(AUDIT_ACTION.autoPause, r.id, `report ${p.report?.id ?? "-"}, reason ${r.reason}`, null);
      this.log.warn({ restrictionId: r.id, reason: r.reason }, "automatic pause applied");
    }
    const view = toPublic(r);
    await this.sink?.restrictionApplied(p.deviceId, view);
    return view;
  }

  /** Carries a ban to the address the device last minted a session on (noted 24 h by noteDeviceNetwork). */
  private async banNetwork(deviceId: string, r: StoredRestriction, now: number): Promise<void> {
    const ip = (await this.store.getValue<DeviceNetwork>(KEY.network(deviceId)))?.ip;
    if (!ip) return;
    const until = Math.min(r.until ?? Number.MAX_SAFE_INTEGER, now + NETWORK_BAN_TTL_MS);
    const mark: NetworkBan = { restrictionId: r.id, until };
    await this.store.setValue(KEY.networkBan(this.network(ip)), mark, until - now);
  }

  private async lift(r: StoredRestriction): Promise<void> {
    if (r.liftedAt !== null) return;
    r.liftedAt = this.now();
    await this.store.put("restriction", r.id, r, restrictionEnd(r));
    const remaining = await this.activeForDevice(r.deviceId);
    await this.sink?.restrictionLifted(r.deviceId, remaining);
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  /** A device may read its own restriction (also one recorded against its fingerprint). */
  private async owns(r: StoredRestriction, deviceId: string): Promise<boolean> {
    if (r.deviceId === deviceId) return true;
    if (!r.fingerprintHash) return false;
    return (await this.store.getValue<string>(KEY.fingerprint(deviceId))) === r.fingerprintHash;
  }

  async restrictionView(id: string, deviceId: string): Promise<RestrictionView | null> {
    const r = await this.store.get<StoredRestriction>("restriction", id);
    if (!r || !(await this.owns(r, deviceId))) return null;
    let evidenceFrame: string | null = null;
    if (r.evidenceAvailable && r.reportId) {
      const report = await this.store.get<StoredReport>("report", r.reportId);
      // Re-checked here: a report can be escalated to the restricted path after the restriction.
      if (report?.evidenceId && !report.restricted && evidenceShowable(r.reason, true, false)) {
        const bytes = await this.evidence.get(report.evidenceId, { restricted: false });
        if (bytes) evidenceFrame = toDataUrl(bytes);
      }
    }
    return { restriction: toPublic(r), evidenceFrame };
  }

  async submitAppeal(req: AppealRequest, ip: string | null): Promise<AppealResponse> {
    if (ip && (await this.store.hit(KEY.appealIpRate(this.network(ip)), HOUR)) > APPEALS_PER_IP_PER_HOUR) {
      return { ok: false, error: "rate_limited" };
    }
    const r = await this.store.get<StoredRestriction>("restriction", req.restrictionId);
    if (!r || !(await this.owns(r, req.deviceId))) return { ok: false, error: "not_found" };
    // Charged only for the device's own restriction: a guessed deviceId must not burn its quota.
    if ((await this.store.hit(KEY.appealDeviceRate(req.deviceId), DAY)) > APPEALS_PER_DEVICE_PER_DAY) {
      return { ok: false, error: "rate_limited" };
    }
    if (!r.appealable) return { ok: false, error: "not_appealable" };
    if (r.appeal.status !== "none" || !(await this.store.claim(KEY.appealClaim(r.id), APPEAL_CLAIM_TTL_MS))) {
      return { ok: false, error: "already_appealed" };
    }
    const now = this.now();
    const appeal: StoredAppeal = {
      id: randomUUID(),
      restrictionId: r.id,
      deviceId: req.deviceId,
      text: req.text,
      createdAt: now,
      dueAt: now + APPEAL_DUE_MS,
      status: "pending",
      decidedAt: null,
      note: null,
    };
    await this.store.put("appeal", appeal.id, appeal, now);
    await this.store.addToIndex(INDEX.pendingAppeals, appeal.id, appeal.dueAt);
    r.appeal = { status: "pending", submittedAt: now };
    await this.store.put("restriction", r.id, r, restrictionEnd(r));
    return { ok: true, appealId: appeal.id };
  }

  async submitTakedown(req: TakedownRequest, ip: string | null): Promise<TakedownResponse> {
    if (ip && (await this.store.hit(KEY.takedownIpRate(this.network(ip)), HOUR)) > TAKEDOWNS_PER_IP_PER_HOUR) {
      return { ok: false, error: "rate_limited" };
    }
    if (!(await this.turnstile(req.turnstileToken, ip))) return { ok: false, error: "turnstile_failed" };
    const now = this.now();
    const t: StoredTakedown = {
      id: randomUUID(),
      kind: req.kind,
      contactEmail: req.contactEmail,
      description: req.description,
      location: req.location?.trim() || null,
      isAffectedPerson: req.isAffectedPerson,
      createdAt: now,
      dueAt: takedownDueAt(req.kind, now),
      status: "open",
      resolution: null,
      restricted: req.kind === "csam",
      resolvedAt: null,
    };
    await this.store.put("takedown", t.id, t, now);
    this.log.info({ ticketId: t.id, kind: t.kind }, "takedown ticket created");
    return { ok: true, ticketId: t.id };
  }

  /* ---------------------------------------------------------------- */
  /* Admin                                                             */
  /* ---------------------------------------------------------------- */

  async audit(action: string, target: string, note: string | null, ip: string | null): Promise<void> {
    const entry: AdminAuditEntry = { id: randomUUID(), ts: this.now(), action, target, note, ip };
    await this.store.put("audit", entry.id, entry, entry.ts);
  }

  /** Idempotency for admin writes: true the first time `key` is seen within ADMIN_IDEMPOTENCY_TTL_MS. */
  async claimAdminRequest(key: string): Promise<boolean> {
    return this.store.claim(KEY.adminRequest(key), ADMIN_IDEMPOTENCY_TTL_MS);
  }

  async listAudit(limit: number, before?: number): Promise<AdminAuditEntry[]> {
    const ids = await this.store.range("audit", {
      reverse: true,
      limit,
      ...(before !== undefined ? { max: before - 1 } : {}),
    });
    return (await this.store.getMany<AdminAuditEntry>("audit", ids)).filter((e): e is AdminAuditEntry => e !== null);
  }

  private async toAdmin(r: StoredReport): Promise<AdminReport> {
    // A count, not the ids: the queue builds up to ADMIN_LIST_LIMIT of these.
    const prior = await this.store.indexCount(KEY.reportsAgainst(r.reportedDevice), { max: r.createdAt - 1 });
    return {
      id: r.id,
      createdAt: r.createdAt,
      reason: r.reason,
      severity: severityOf(r.reason, r.restricted),
      status: r.status,
      roomId: r.roomId,
      reporter: this.pseudonym(r.reporterDevice),
      reported: this.pseudonym(r.reportedDevice),
      reporterWeight: r.reporterWeight,
      details: r.details,
      hasFrame: r.evidenceId !== null,
      chat: r.chat,
      restricted: r.restricted,
      nsfwScore: r.nsfwScore,
      ...reportSla(r.reason, r.restricted, r.createdAt),
      priorReportsAgainst: prior,
    };
  }

  /**
   * The review queue: open and acknowledged reports by severity, then by the
   * next due clock. `status` lists the most recent reports in that status instead.
   */
  async queue(status?: AdminReport["status"] | "all"): Promise<AdminReport[]> {
    if (status && status !== "open") {
      const ids = await this.store.range("report", { reverse: true, limit: ADMIN_LIST_LIMIT });
      const reports = (await this.store.getMany<StoredReport>("report", ids)).filter(
        (r): r is StoredReport => r !== null && (status === "all" || r.status === status),
      );
      return Promise.all(reports.map((r) => this.toAdmin(r)));
    }
    // Oldest first, capped: the sort below still puts the most urgent of them on top.
    const ids = await this.store.indexRange(INDEX.openReports, { limit: ADMIN_LIST_LIMIT });
    const reports = (await this.store.getMany<StoredReport>("report", ids)).filter(
      (r): r is StoredReport => r !== null,
    );
    const admin = await Promise.all(reports.map((r) => this.toAdmin(r)));
    const due = (a: AdminReport) => (a.status === "open" ? a.ackDueAt : a.resolveDueAt);
    return admin.sort((a, b) => {
      const [sa, ra] = queueRank(a.reason, a.restricted);
      const [sb, rb] = queueRank(b.reason, b.restricted);
      return sa - sb || ra - rb || due(a) - due(b);
    });
  }

  async report(id: string): Promise<AdminReport | null> {
    const r = await this.store.get<StoredReport>("report", id);
    return r ? this.toAdmin(r) : null;
  }

  /** The evidence JPEG for review. Never for restricted items. Every attempt is audited. */
  async evidenceImage(id: string, actor: Actor): Promise<AdminResult<Uint8Array>> {
    const r = await this.store.get<StoredReport>("report", id);
    if (!r) return fail("not_found");
    if (r.restricted) {
      await this.audit(AUDIT_ACTION.evidenceDenied, id, "restricted item", actor.ip);
      return fail("restricted");
    }
    if (!r.evidenceId) return fail("not_found");
    const bytes = await this.evidence.get(r.evidenceId, { restricted: false });
    if (!bytes) return fail("not_found");
    await this.audit(AUDIT_ACTION.viewEvidence, id, null, actor.ip);
    if (!r.humanViewed) {
      r.humanViewed = true;
      await this.store.put("report", r.id, r, r.createdAt);
    }
    return ok(bytes);
  }

  /** First decision on a report updates the reporter's upheld share. */
  private async decide(r: StoredReport, status: StoredReport["status"], upheld: boolean): Promise<void> {
    const first = r.decidedAt === null;
    r.status = status;
    r.decidedAt ??= this.now();
    await this.store.put("report", r.id, r, r.createdAt);
    await this.store.removeFromIndex(INDEX.openReports, r.id);
    if (first) {
      const field = upheld ? DEVICE_FIELD.upheld : DEVICE_FIELD.dismissed;
      await this.store.incrField(KEY.device(r.reporterDevice), field, 1, DEVICE_TTL_MS);
    }
  }

  /** Earlier human actions on the device that still count on the ladder. */
  private async confirmedCount(deviceId: string): Promise<number> {
    const ids = await this.store.indexRange(KEY.restrictions(deviceId));
    const all = await this.store.getMany<StoredRestriction>("restriction", ids);
    return all.filter((r) => r && !r.auto && r.liftedAt === null).length;
  }

  async actOnReport(
    id: string,
    action: AdminReportAction,
    actor: Actor,
  ): Promise<AdminResult<{ report: AdminReport; restriction: Restriction | null; packet: CsamReportPacket | null }>> {
    if (action.action === "escalate_csam") {
      const res = await this.escalate(id, actor, action.note);
      if (!res.ok) return res;
      const report = await this.report(id);
      return ok({ report: report!, restriction: res.value.restriction, packet: res.value.packet });
    }
    const r = await this.store.get<StoredReport>("report", id);
    if (!r) return fail("not_found");
    let restriction: Restriction | null = null;
    switch (action.action) {
      case "acknowledge":
        if (r.status !== "open") return fail("conflict");
        r.status = "acknowledged";
        r.acknowledgedAt = this.now();
        await this.store.put("report", r.id, r, r.createdAt);
        break;
      case "dismiss": {
        await this.decide(r, "dismissed", false);
        // An automatic pause caused by this report goes away with it.
        const linked = r.restrictionId ? await this.store.get<StoredRestriction>("restriction", r.restrictionId) : null;
        if (linked?.auto) await this.lift(linked);
        break;
      }
      case "warn":
      case "restrict": {
        const reason = action.reason ?? restrictionReasonFor(r.reason, r.restricted);
        const step =
          action.action === "restrict" && action.durationMs !== undefined
            ? action.durationMs
            : ladderStep(action.action, await this.confirmedCount(r.reportedDevice));
        await this.decide(r, "actioned", true);
        restriction = await this.restrict({ deviceId: r.reportedDevice, reason, step, auto: false, report: r });
        break;
      }
    }
    await this.audit(`report.${action.action}`, id, action.note ?? null, actor.ip);
    return ok({ report: (await this.report(id))!, restriction, packet: null });
  }

  /**
   * Escalates suspected CSAM: moves the evidence to the restricted path if
   * needed (without anyone viewing it), freezes it for 1 year, bans the
   * reported device (generic copy, no evidence shown) and builds the
   * NCMEC CyberTipline / NCRP packet from metadata only.
   */
  async escalate(
    id: string,
    actor: Actor,
    note?: string,
  ): Promise<AdminResult<{ packet: CsamReportPacket; restriction: Restriction | null }>> {
    const r = await this.store.get<StoredReport>("report", id);
    if (!r) return fail("not_found");
    const now = this.now();
    if (!r.restricted && r.evidenceId) {
      const bytes = await this.evidence.get(r.evidenceId, { restricted: false });
      if (bytes) await this.evidence.put(r.evidenceId, bytes, { restricted: true });
      await this.evidence.delete(r.evidenceId, { restricted: false });
    }
    r.restricted = true;
    r.legalHold = true;
    r.preservedUntil = Math.max(r.preservedUntil ?? 0, now + CSAM_PRESERVE_MS);
    r.reportedNetwork ??= await this.store.getValue<DeviceNetwork>(KEY.network(r.reportedDevice));
    const already = r.status === "escalated";
    await this.decide(r, "escalated", true);

    let restriction: Restriction | null = null;
    if (!already) {
      restriction = await this.restrict({
        deviceId: r.reportedDevice,
        reason: "minor-safety",
        step: null,
        auto: false,
        report: r,
      });
    }
    const packet: CsamReportPacket = {
      reportId: r.id,
      generatedAt: now,
      incidentAt: r.createdAt,
      reason: r.reason,
      classifierScore: r.nsfwScore,
      humanViewed: r.humanViewed,
      reportedDevice: this.pseudonym(r.reportedDevice),
      reportedIpAddress: r.reportedNetwork?.ip ?? null,
      reportedCountry: r.reportedNetwork?.country ?? null,
      evidenceSha256: r.evidenceSha256,
      evidencePreservedUntil: r.preservedUntil,
      chat: r.chat,
    };
    await this.audit(AUDIT_ACTION.escalateCsam, id, note ?? null, actor.ip);
    return ok({ packet, restriction });
  }

  /**
   * Ends a legal hold early (the legal process is closed): the report and its
   * audit trail fall back to normal retention, so a report older than
   * RETENTION_MS goes at the next sweep. The evidence stays on the restricted path.
   */
  async releaseHold(id: string, actor: Actor, note?: string): Promise<AdminResult<AdminReport>> {
    const r = await this.store.get<StoredReport>("report", id);
    if (!r) return fail("not_found");
    if (!r.legalHold) return fail("conflict");
    r.legalHold = false;
    r.preservedUntil = null;
    await this.store.put("report", r.id, r, r.createdAt);
    await this.audit(AUDIT_ACTION.releaseHold, id, note ?? null, actor.ip);
    return ok(await this.toAdmin(r));
  }

  async listAppeals(): Promise<AdminAppeal[]> {
    const ids = await this.store.range("appeal", { reverse: true, limit: ADMIN_LIST_LIMIT });
    const appeals = (await this.store.getMany<StoredAppeal>("appeal", ids)).filter(
      (a): a is StoredAppeal => a !== null,
    );
    const restrictions = await this.store.getMany<StoredRestriction>(
      "restriction",
      appeals.map((a) => a.restrictionId),
    );
    const out: AdminAppeal[] = [];
    appeals.forEach((a, i) => {
      const r = restrictions[i];
      if (!r) return;
      out.push({
        id: a.id,
        restrictionId: a.restrictionId,
        restriction: toPublic(r),
        text: a.text,
        createdAt: a.createdAt,
        dueAt: a.dueAt,
        status: a.status,
      });
    });
    const pending = (a: AdminAppeal) => (a.status === "pending" ? 0 : 1);
    return out.sort((a, b) => pending(a) - pending(b) || (pending(a) === 0 ? a.dueAt - b.dueAt : b.createdAt - a.createdAt));
  }

  async decideAppeal(
    id: string,
    decision: "uphold" | "overturn",
    note: string | undefined,
    actor: Actor,
  ): Promise<AdminResult<AdminAppeal>> {
    const a = await this.store.get<StoredAppeal>("appeal", id);
    if (!a) return fail("not_found");
    if (a.status !== "pending") return fail("conflict");
    const r = await this.store.get<StoredRestriction>("restriction", a.restrictionId);
    if (!r) return fail("not_found");
    const now = this.now();
    a.status = decision === "overturn" ? "overturned" : "upheld";
    a.decidedAt = now;
    a.note = note ?? null;
    await this.store.put("appeal", a.id, a, a.createdAt);
    await this.store.removeFromIndex(INDEX.pendingAppeals, a.id);
    r.appeal = { status: a.status, submittedAt: a.createdAt, decidedAt: now };
    await this.store.put("restriction", r.id, r, restrictionEnd(r));
    if (decision === "overturn") await this.lift(r);
    await this.audit(`appeal.${decision}`, id, note ?? null, actor.ip);
    const fresh = (await this.store.get<StoredRestriction>("restriction", r.id))!;
    const { deviceId: _d, decidedAt: _t, note: _n, ...rest } = a;
    return ok({ ...rest, restriction: toPublic(fresh) });
  }

  async listTakedowns(): Promise<AdminTakedown[]> {
    const ids = await this.store.range("takedown", { reverse: true, limit: ADMIN_LIST_LIMIT });
    const list = (await this.store.getMany<StoredTakedown>("takedown", ids)).filter(
      (t): t is StoredTakedown => t !== null,
    );
    const open = (t: StoredTakedown) => (t.status === "open" ? 0 : 1);
    return list
      .sort((a, b) => open(a) - open(b) || (open(a) === 0 ? a.dueAt - b.dueAt : b.createdAt - a.createdAt))
      .map(({ restricted: _r, resolvedAt: _t, ...t }) => t);
  }

  async resolveTakedown(id: string, resolution: string, actor: Actor): Promise<AdminResult<AdminTakedown>> {
    const t = await this.store.get<StoredTakedown>("takedown", id);
    if (!t) return fail("not_found");
    if (t.status !== "open") return fail("conflict");
    t.status = "resolved";
    t.resolution = resolution;
    t.resolvedAt = this.now();
    await this.store.put("takedown", t.id, t, t.createdAt);
    await this.audit(AUDIT_ACTION.resolveTakedown, id, null, actor.ip);
    const { restricted: _r, resolvedAt: _t, ...view } = t;
    return ok(view);
  }

  /* ---------------------------------------------------------------- */
  /* Retention                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Deletes reports and their evidence older than 1 year, restriction records
   * 1 year after they ended (with their appeals), takedown tickets resolved
   * over a year ago and audit entries older than a year (except those about
   * a report on legal hold). A report on legal hold is kept until its
   * `preservedUntil` passes (escalating again renews it); an expired hold no
   * longer protects it. Idempotent. A report whose evidence cannot be deleted
   * keeps its record (the only pointer to the file) for the next day's sweep;
   * the rest of the sweep goes on.
   */
  async sweepRetention(): Promise<{
    reports: number;
    restrictions: number;
    appeals: number;
    takedowns: number;
    audit: number;
    evidenceErrors: number;
  }> {
    const now = this.now();
    const cutoff = now - RETENTION_MS;
    const counts = { reports: 0, restrictions: 0, appeals: 0, takedowns: 0, audit: 0, evidenceErrors: 0 };
    const held = (r: StoredReport | null) => r !== null && r.legalHold && (r.preservedUntil === null || r.preservedUntil > now);

    for (const id of await this.store.range("report", { max: cutoff })) {
      const r = await this.store.get<StoredReport>("report", id);
      if (held(r)) continue;
      if (r?.evidenceId) {
        try {
          await this.evidence.delete(r.evidenceId, { restricted: r.restricted });
        } catch (err) {
          counts.evidenceErrors++;
          this.log.error({ err, reportId: id }, "retention: could not delete evidence; the report is kept for the next sweep");
          continue;
        }
      }
      if (r) await this.store.removeFromIndex(KEY.reportsAgainst(r.reportedDevice), id);
      await this.store.removeFromIndex(INDEX.openReports, id);
      await this.store.delete("report", id);
      counts.reports++;
    }

    for (const id of await this.store.range("restriction", { max: cutoff })) {
      const r = await this.store.get<StoredRestriction>("restriction", id);
      if (r) {
        await this.store.removeFromIndex(KEY.restrictions(r.deviceId), id);
        if (r.fingerprintHash) await this.store.removeFromIndex(KEY.restrictionsByFingerprint(r.fingerprintHash), id);
      }
      await this.store.delete("restriction", id);
      counts.restrictions++;
    }

    for (const id of await this.store.range("appeal", { max: cutoff })) {
      const a = await this.store.get<StoredAppeal>("appeal", id);
      if (a && (await this.store.get("restriction", a.restrictionId))) continue;
      await this.store.removeFromIndex(INDEX.pendingAppeals, id);
      await this.store.delete("appeal", id);
      counts.appeals++;
    }

    for (const id of await this.store.range("takedown", { max: cutoff })) {
      const t = await this.store.get<StoredTakedown>("takedown", id);
      if (t && (t.resolvedAt === null || t.resolvedAt > cutoff)) continue;
      await this.store.delete("takedown", id);
      counts.takedowns++;
    }

    for (const id of await this.store.range("audit", { max: cutoff })) {
      const entry = await this.store.get<AdminAuditEntry>("audit", id);
      // The trail of a report frozen for a legal process stays with it.
      if (entry && held(await this.store.get<StoredReport>("report", entry.target))) continue;
      await this.store.delete("audit", id);
      counts.audit++;
    }
    return counts;
  }

  /** Runs the retention sweep once a day across all instances (an hourly check takes a daily claim). */
  start(checkEveryMs = RETENTION_CHECK_INTERVAL_MS): void {
    if (this.timer) return;
    const tick = () => {
      if (this.sweeping) return;
      const day = Math.floor(this.now() / DAY);
      this.sweeping = this.store
        .claim(KEY.retentionClaim(day), DAY)
        .then((mine) => (mine ? this.sweepRetention() : null))
        .then((counts) => {
          if (counts) this.log.info(counts, "retention sweep done");
        })
        .catch((err: unknown) => this.log.error({ err }, "retention sweep failed"))
        .finally(() => {
          this.sweeping = undefined;
        });
    };
    this.timer = setInterval(tick, checkEveryMs);
    this.timer.unref?.();
    tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.sweeping;
  }
}
