/**
 * Stored enforcement records. Raw device ids appear only here, server side;
 * the admin API shows salted pseudonyms (see EnforcementService.pseudonym).
 */
import type { AdminAppeal, AdminReport, AdminTakedown, ReportReason, Restriction } from "../protocol";

export type ChatLine = AdminReport["chat"][number];

export interface StoredReport {
  id: string;
  createdAt: number;
  roomId: string;
  reason: ReportReason;
  reporterDevice: string;
  /** Salted hash of the reporter's address bucket (never the IP), or null when unknown; reporters on one address count once. */
  reporterNetwork: string | null;
  reportedDevice: string;
  /** Reporter weight at report time (0..1). */
  reporterWeight: number;
  details: string | null;
  /** Lines the reporter's client attached. Stored with the report only. */
  chat: ChatLine[];
  evidenceId: string | null;
  evidenceSha256: string | null;
  /** Routed to the restricted (suspected CSAM) store. */
  restricted: boolean;
  nsfwScore: number | null;
  minorScore: number | null;
  status: AdminReport["status"];
  /** The call never connected or lasted under 2 s: the report carries less weight. */
  shortCall: boolean;
  /** An admin opened the evidence image. */
  humanViewed: boolean;
  /** Frozen for a legal process: the retention sweep keeps it. */
  legalHold: boolean;
  preservedUntil: number | null;
  acknowledgedAt: number | null;
  decidedAt: number | null;
  /** Restriction applied because of this report (automatic or by an admin). */
  restrictionId: string | null;
  /** Snapshot for CSAM packets, taken only for restricted reports (IPs are not kept otherwise). */
  reportedNetwork: DeviceNetwork | null;
}

export interface StoredRestriction extends Restriction {
  deviceId: string;
  fingerprintHash: string | null;
  reportId: string | null;
  /** Applied automatically from reports (always a short pause, never counts on the ladder). */
  auto: boolean;
  /** Set when lifted early (appeal overturned, report dismissed). */
  liftedAt: number | null;
}

export interface StoredAppeal extends Omit<AdminAppeal, "restriction"> {
  deviceId: string;
  decidedAt: number | null;
  note: string | null;
}

export interface StoredTakedown extends AdminTakedown {
  /** csam notices: handled on the restricted path, never with images. */
  restricted: boolean;
  resolvedAt: number | null;
}

export interface DeviceStats {
  firstSeen: number | null;
  completedCalls: number;
  /** Past reports BY this device that an admin upheld or dismissed. */
  upheld: number;
  dismissed: number;
  /** A human or a risk signal marked this device as possibly a minor. */
  minorFlag: boolean;
}

/** The room a device was last in, kept briefly so a report can follow the call. */
export interface LastRoom {
  roomId: string;
  devices: [string, string];
  activeSince: number | null;
  endedAt: number;
}

/** Network facts about a device, kept briefly for CSAM packets only. */
export interface DeviceNetwork {
  ip: string | null;
  country: string | null;
}
