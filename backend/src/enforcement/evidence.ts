/**
 * Evidence frames: validation of the reporter-supplied JPEG and byte storage.
 *
 * The frame is attacker-controlled (a modified client can upload anything), so
 * it is re-validated here, stored under a random id (never a device id), and
 * hashed. Restricted items (suspected CSAM) live under a separate path that the
 * admin console can never read (see EnforcementService.evidenceImage).
 *
 * Two backends: a local directory (0700) or S3 with server-side encryption.
 * Evidence bytes never go to Redis.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Decoded size cap. The protocol caps the data URL at 120k chars, about 90 KB of JPEG. */
export const EVIDENCE_MAX_BYTES = 96 * 1024;
const DATA_URL_PREFIX = "data:image/jpeg;base64,";

export interface EvidenceFrame {
  bytes: Uint8Array;
  sha256: string;
}

/**
 * Decodes and checks a JPEG data URL: strict base64, JPEG magic bytes FF D8 FF,
 * size cap. Returns null when anything is off.
 */
export function parseEvidenceFrame(dataUrl: string): EvidenceFrame | null {
  if (!dataUrl.startsWith(DATA_URL_PREFIX)) return null;
  const b64 = dataUrl.slice(DATA_URL_PREFIX.length);
  if (b64.length === 0 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.length < 4 || bytes.length > EVIDENCE_MAX_BYTES) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function toDataUrl(bytes: Uint8Array): string {
  return DATA_URL_PREFIX + Buffer.from(bytes).toString("base64");
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

const SAFE_ID = /^[a-f0-9-]{36}$/;

function checkId(id: string): void {
  // Ids are server-generated UUIDs; refuse anything else so a path can never escape the directory.
  if (!SAFE_ID.test(id)) throw new Error("invalid evidence id");
}

/** Files in `<dir>/general` and `<dir>/restricted`, directories 0700, files 0600. */
export class FsEvidenceStore implements EvidenceStore {
  private ready?: Promise<void>;

  constructor(private readonly dir: string) {}

  private sub(where: EvidenceLocation): string {
    return join(this.dir, where.restricted ? "restricted" : "general");
  }

  private ensureDirs(): Promise<void> {
    this.ready ??= (async () => {
      for (const d of [this.dir, this.sub({ restricted: false }), this.sub({ restricted: true })]) {
        await mkdir(d, { recursive: true, mode: 0o700 });
        // mkdir's mode is masked by the umask and ignored for existing directories.
        await chmod(d, 0o700);
      }
    })().catch((err: unknown) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  async put(id: string, bytes: Uint8Array, where: EvidenceLocation): Promise<void> {
    checkId(id);
    await this.ensureDirs();
    await writeFile(join(this.sub(where), `${id}.jpg`), bytes, { mode: 0o600, flag: "wx" });
  }

  async get(id: string, where: EvidenceLocation): Promise<Uint8Array | null> {
    checkId(id);
    try {
      return new Uint8Array(await readFile(join(this.sub(where), `${id}.jpg`)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(id: string, where: EvidenceLocation): Promise<void> {
    checkId(id);
    await rm(join(this.sub(where), `${id}.jpg`), { force: true });
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
    return `${where.restricted ? "restricted" : "general"}/${id}.jpg`;
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
        ContentType: "image/jpeg",
        ...sse,
      }),
    );
  }

  async get(id: string, where: EvidenceLocation): Promise<Uint8Array | null> {
    try {
      const res = (await this.client.send(
        new this.opts.commands.GetObjectCommand({ Bucket: this.opts.bucket, Key: this.key(id, where) }),
      )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
      return res.Body ? await res.Body.transformToByteArray() : null;
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
