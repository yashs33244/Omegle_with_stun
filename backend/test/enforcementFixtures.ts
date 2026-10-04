/**
 * Shared fixtures for enforcement tests: fake JPEG evidence and an
 * EnforcementService on a memory store with a controllable clock.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnforcementService, type RestrictionSink } from "../src/enforcement/EnforcementService";
import { FsEvidenceStore, toDataUrl, type EvidenceStore } from "../src/enforcement/evidence";
import type { FrameClassifier } from "../src/enforcement/policy";
import { MemoryEnforcementStore, type EnforcementStore } from "../src/enforcement/store";
import { createLogger } from "../src/logger";
import type { Restriction } from "../src/protocol";

/** Bytes that pass the JPEG checks (SOI marker, random body, EOI marker). */
export function jpegBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(randomBytes(Math.max(size, 6)));
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  return bytes;
}

export function jpegDataUrl(size = 2_000): string {
  return toDataUrl(jpegBytes(size));
}

export class RecordingSink implements RestrictionSink {
  readonly applied: { deviceId: string; restriction: Restriction }[] = [];
  readonly lifted: { deviceId: string; remaining: Restriction | null }[] = [];

  async restrictionApplied(deviceId: string, restriction: Restriction): Promise<void> {
    this.applied.push({ deviceId, restriction });
  }

  async restrictionLifted(deviceId: string, remaining: Restriction | null): Promise<void> {
    this.lifted.push({ deviceId, remaining });
  }
}

/** Counts reads so tests can prove restricted evidence is never opened. */
export class SpyEvidenceStore implements EvidenceStore {
  reads: { id: string; restricted: boolean }[] = [];

  constructor(readonly inner: EvidenceStore) {}

  put(id: string, bytes: Uint8Array, where: { restricted: boolean }) {
    return this.inner.put(id, bytes, where);
  }

  get(id: string, where: { restricted: boolean }) {
    this.reads.push({ id, restricted: where.restricted });
    return this.inner.get(id, where);
  }

  delete(id: string, where: { restricted: boolean }) {
    return this.inner.delete(id, where);
  }
}

export interface Harness {
  service: EnforcementService;
  store: EnforcementStore;
  evidence: SpyEvidenceStore;
  sink: RecordingSink;
  dir: string;
  clock: { now: number };
}

export function harness(
  opts: { turnstile?: (t: string | undefined) => Promise<boolean>; classifier?: FrameClassifier } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "chizzy-enf-"));
  const store = new MemoryEnforcementStore();
  const evidence = new SpyEvidenceStore(new FsEvidenceStore(dir));
  const sink = new RecordingSink();
  const clock = { now: Date.now() };
  const service = new EnforcementService({
    store,
    evidence,
    logger: createLogger("silent"),
    turnstile: opts.turnstile ?? (async () => true),
    classifier: opts.classifier,
    pseudonymSalt: "test-salt-0123456789",
    now: () => clock.now,
  });
  service.setSink(sink);
  return { service, store, evidence, sink, dir, clock };
}
