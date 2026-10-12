/**
 * Evidence frames: validation of the reporter-supplied JPEG and byte storage.
 *
 * The frame is attacker-controlled (a modified client can upload anything), so
 * it is re-validated here, stored under a random id (never a device id), and
 * hashed. Restricted items (suspected CSAM) live under a separate path that the
 * admin console can never read (see EnforcementService.evidenceImage).
 *
 * Two backends: a local directory (0700) or S3 with server-side encryption.
 * Evidence bytes never go to Redis. Reads are capped at EVIDENCE_MAX_BYTES
 * and must still be a JPEG: the admin route serves them as image/jpeg.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EVIDENCE_AREA,
  EVIDENCE_CONTENT_TYPE,
  EVIDENCE_DIR_MODE,
  EVIDENCE_EXTENSION,
  EVIDENCE_FILE_MODE,
  EVIDENCE_ID_PATTERN,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MIN_BYTES,
  JPEG_DATA_URL_PREFIX,
  JPEG_MAGIC,
} from "./constants";

export interface EvidenceFrame {
  bytes: Uint8Array;
  sha256: string;
}

/**
 * Decodes and checks a JPEG data URL: strict base64, JPEG magic bytes FF D8 FF,
 * size cap. Returns null when anything is off.
 */
export function parseEvidenceFrame(dataUrl: string): EvidenceFrame | null {
  if (!dataUrl.startsWith(JPEG_DATA_URL_PREFIX)) return null;
  const b64 = dataUrl.slice(JPEG_DATA_URL_PREFIX.length);
  if (b64.length === 0 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.length < EVIDENCE_MIN_BYTES || bytes.length > EVIDENCE_MAX_BYTES) return null;
  if (!isJpeg(bytes)) return null;
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function isJpeg(bytes: Uint8Array): boolean {
  return JPEG_MAGIC.every((byte, i) => bytes[i] === byte);
}

/** Bytes read back from storage: over the cap or not a JPEG means the store was tampered with or corrupted. */
function checkStored(bytes: Uint8Array): Uint8Array {
  if (bytes.length > EVIDENCE_MAX_BYTES) throw new Error("stored evidence exceeds the size cap");
  if (!isJpeg(bytes)) throw new Error("stored evidence is not a JPEG");
  return bytes;
}

export function toDataUrl(bytes: Uint8Array): string {
  return JPEG_DATA_URL_PREFIX + Buffer.from(bytes).toString("base64");
}

export interface EvidenceLocation {
  /** Suspected CSAM: stored apart, never served to the console or back to users. */
  restricted: boolean;
}

export interface EvidenceStore {
  put(id: string, bytes: Uint8Array, where: EvidenceLocation): Promise<void>;
  get(id: string, where: EvidenceLocation): Promise<Uint8Array | null>;
  delete(id: string, where: EvidenceLocation): Promise<void>;
}

function checkId(id: string): void {
  if (!EVIDENCE_ID_PATTERN.test(id)) throw new Error("invalid evidence id");
}

/** Storage area (directory or S3 prefix) for a location. */
function areaOf(where: EvidenceLocation): string {
  return where.restricted ? EVIDENCE_AREA.restricted : EVIDENCE_AREA.general;
}

/** Files in `<dir>/general` and `<dir>/restricted`, directories EVIDENCE_DIR_MODE, files EVIDENCE_FILE_MODE. */
export class FsEvidenceStore implements EvidenceStore {
  private ready?: Promise<void>;

  constructor(private readonly dir: string) {}

  private sub(where: EvidenceLocation): string {
    return join(this.dir, areaOf(where));
  }

  private ensureDirs(): Promise<void> {
    this.ready ??= (async () => {
      for (const d of [this.dir, this.sub({ restricted: false }), this.sub({ restricted: true })]) {
        await mkdir(d, { recursive: true, mode: EVIDENCE_DIR_MODE });
        // mkdir's mode is masked by the umask and ignored for existing directories.
        await chmod(d, EVIDENCE_DIR_MODE);
      }
    })().catch((err: unknown) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  /**
   * Write-once. Writing the same bytes again succeeds, so a retried escalation
   * (copy to restricted, then delete general) can finish after a partial failure.
   */
  async put(id: string, bytes: Uint8Array, where: EvidenceLocation): Promise<void> {
    checkId(id);
    await this.ensureDirs();
    const path = this.path(id, where);
    try {
      await writeFile(path, bytes, { mode: EVIDENCE_FILE_MODE, flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!(await readFile(path)).equals(bytes)) throw err;
    }
  }

  async get(id: string, where: EvidenceLocation): Promise<Uint8Array | null> {
    checkId(id);
    let file;
    try {
      file = await open(this.path(id, where), "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      // Checked before reading, so an oversized file is never loaded.
      if ((await file.stat()).size > EVIDENCE_MAX_BYTES) throw new Error("stored evidence exceeds the size cap");
      return checkStored(new Uint8Array(await file.readFile()));
    } finally {
      await file.close();
    }
  }

  async delete(id: string, where: EvidenceLocation): Promise<void> {
    checkId(id);
    await rm(this.path(id, where), { force: true });
  }

  /** `id` must have passed checkId: it then has no separators or dots and stays inside the area directory. */
  private path(id: string, where: EvidenceLocation): string {
    return join(this.sub(where), `${id}${EVIDENCE_EXTENSION}`);
  }
}

/** The subset of the AWS SDK v3 S3 client this store uses (injectable for tests). */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

export interface S3EvidenceOptions {
  bucket: string;
  /** SSE-KMS key id; without it objects use SSE-S3 (AES256). */
  kmsKeyId?: string;
  /** Command constructors from @aws-sdk/client-s3 (injected so tests need no network). */
  commands: {
    PutObjectCommand: new (input: Record<string, unknown>) => unknown;
    GetObjectCommand: new (input: Record<string, unknown>) => unknown;
    DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
  };
}

/**
 * Objects at `general/<id>.jpg` and `restricted/<id>.jpg`, always encrypted at
 * rest. Bucket policy, Object Lock and lifecycle rules are set up by the operator
 * (see the retention table in the docs).
 */
export class S3EvidenceStore implements EvidenceStore {
  constructor(
    private readonly client: S3Like,
    private readonly opts: S3EvidenceOptions,
  ) {}

  private key(id: string, where: EvidenceLocation): string {
    checkId(id);
    return `${areaOf(where)}/${id}${EVIDENCE_EXTENSION}`;
  }

  async put(id: string, bytes: Uint8Array, where: EvidenceLocation): Promise<void> {
    const sse = this.opts.kmsKeyId
      ? { ServerSideEncryption: "aws:kms", SSEKMSKeyId: this.opts.kmsKeyId }
      : { ServerSideEncryption: "AES256" };
    await this.client.send(
      new this.opts.commands.PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: this.key(id, where),
        Body: bytes,
        ContentType: EVIDENCE_CONTENT_TYPE,
        ...sse,
      }),
    );
  }

  async get(id: string, where: EvidenceLocation): Promise<Uint8Array | null> {
    try {
      // One byte past the cap: enough to tell an oversized object apart without downloading it.
      const res = (await this.client.send(
        new this.opts.commands.GetObjectCommand({
          Bucket: this.opts.bucket,
          Key: this.key(id, where),
          Range: `bytes=0-${EVIDENCE_MAX_BYTES}`,
        }),
      )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
      return res.Body ? checkStored(await res.Body.transformToByteArray()) : null;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") return null;
      throw err;
    }
  }

  async delete(id: string, where: EvidenceLocation): Promise<void> {
    await this.client.send(
      new this.opts.commands.DeleteObjectCommand({ Bucket: this.opts.bucket, Key: this.key(id, where) }),
    );
  }
}

/**
 * Builds the S3 store with the real SDK. The SDK is loaded on first use, so
 * servers without a bucket never load it.
 */
export function createS3EvidenceStore(bucket: string, region?: string, kmsKeyId?: string): EvidenceStore {
  let inner: Promise<EvidenceStore> | undefined;
  const load = () =>
    (inner ??= import("@aws-sdk/client-s3").then((sdk) => {
      type Commands = S3EvidenceOptions["commands"];
      return new S3EvidenceStore(new sdk.S3Client(region ? { region } : {}), {
        bucket,
        kmsKeyId,
        commands: {
          PutObjectCommand: sdk.PutObjectCommand as unknown as Commands["PutObjectCommand"],
          GetObjectCommand: sdk.GetObjectCommand as unknown as Commands["GetObjectCommand"],
          DeleteObjectCommand: sdk.DeleteObjectCommand as unknown as Commands["DeleteObjectCommand"],
        },
      });
    }));
  return {
    put: async (id, bytes, where) => (await load()).put(id, bytes, where),
    get: async (id, where) => (await load()).get(id, where),
    delete: async (id, where) => (await load()).delete(id, where),
  };
}
