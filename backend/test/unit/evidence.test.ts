import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_MAX_BYTES,
  FsEvidenceStore,
  S3EvidenceStore,
  parseEvidenceFrame,
  toDataUrl,
  type S3EvidenceOptions,
} from "../../src/enforcement/evidence";
import { createTurnstileVerifier } from "../../src/enforcement/turnstile";
import { jpegBytes, jpegDataUrl } from "../enforcementFixtures";

describe("parseEvidenceFrame", () => {
  test("accepts a JPEG data URL and hashes the bytes", () => {
    const bytes = jpegBytes(500);
    const frame = parseEvidenceFrame(toDataUrl(bytes));
    expect(frame).not.toBeNull();
    expect([...frame!.bytes]).toEqual([...bytes]);
    expect(frame!.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  test("rejects other magic bytes, bad base64, other types and oversize frames", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(parseEvidenceFrame(`data:image/jpeg;base64,${png.toString("base64")}`)).toBeNull();
    expect(parseEvidenceFrame(`data:image/png;base64,${Buffer.from(jpegBytes(10)).toString("base64")}`)).toBeNull();
    expect(parseEvidenceFrame("data:image/jpeg;base64,/9j/4A")).toBeNull(); // not a multiple of 4
    expect(parseEvidenceFrame("data:image/jpeg;base64,/9j/4A==\n")).toBeNull();
    expect(parseEvidenceFrame("data:image/jpeg;base64,")).toBeNull();
    expect(parseEvidenceFrame(jpegDataUrl(EVIDENCE_MAX_BYTES + 1))).toBeNull();
    expect(parseEvidenceFrame(jpegDataUrl(EVIDENCE_MAX_BYTES))).not.toBeNull();
  });
});

describe("FsEvidenceStore", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("stores under random ids with 0700 directories and 0600 files, restricted kept apart", async () => {
    dir = join(mkdtempSync(join(tmpdir(), "chizzy-ev-")), "evidence");
    const store = new FsEvidenceStore(dir);
    const id = randomUUID();
    const bytes = jpegBytes(64);
    await store.put(id, bytes, { restricted: false });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "general")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "restricted")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "general", `${id}.jpg`)).mode & 0o777).toBe(0o600);
    expect([...(await store.get(id, { restricted: false }))!]).toEqual([...bytes]);
    expect(await store.get(id, { restricted: true })).toBeNull();

    const secret = randomUUID();
    await store.put(secret, bytes, { restricted: true });
    expect(await store.get(secret, { restricted: false })).toBeNull();
    expect(await store.get(secret, { restricted: true })).not.toBeNull();

    await store.delete(id, { restricted: false });
    expect(await store.get(id, { restricted: false })).toBeNull();
    await store.delete(id, { restricted: false }); // idempotent
  });

  test("refuses ids that are not server UUIDs", async () => {
    dir = mkdtempSync(join(tmpdir(), "chizzy-ev-"));
    const store = new FsEvidenceStore(dir);
    await expect(store.put("../../etc/passwd", jpegBytes(8), { restricted: false })).rejects.toThrow("invalid evidence id");
    await expect(store.get("abc", { restricted: false })).rejects.toThrow("invalid evidence id");
  });
});

describe("S3EvidenceStore", () => {
  class Cmd {
    constructor(
      readonly kind: string,
      readonly input: Record<string, unknown>,
    ) {}
  }
  const commands: S3EvidenceOptions["commands"] = {
    PutObjectCommand: class extends Cmd {
      constructor(i: Record<string, unknown>) {
        super("put", i);
      }
    },
    GetObjectCommand: class extends Cmd {
      constructor(i: Record<string, unknown>) {
        super("get", i);
      }
    },
    DeleteObjectCommand: class extends Cmd {
      constructor(i: Record<string, unknown>) {
        super("delete", i);
      }
    },
  };

  function fakeS3() {
    const objects = new Map<string, Uint8Array>();
    const sent: Cmd[] = [];
    return {
      sent,
      objects,
      async send(command: unknown) {
        const c = command as Cmd;
        sent.push(c);
        const key = c.input.Key as string;
        if (c.kind === "put") objects.set(key, c.input.Body as Uint8Array);
        if (c.kind === "delete") objects.delete(key);
        if (c.kind === "get") {
          const body = objects.get(key);
          if (!body) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
          return { Body: { transformToByteArray: async () => body } };
        }
        return {};
      },
    };
  }

  test("encrypts every object and keeps restricted items under their own prefix", async () => {
    const s3 = fakeS3();
    const store = new S3EvidenceStore(s3, { bucket: "ev", commands });
    const id = randomUUID();
    await store.put(id, jpegBytes(16), { restricted: true });
    expect(s3.sent[0]!.input).toMatchObject({
      Bucket: "ev",
      Key: `restricted/${id}.jpg`,
      ContentType: "image/jpeg",
      ServerSideEncryption: "AES256",
    });
    expect(await store.get(id, { restricted: false })).toBeNull();
    expect(await store.get(id, { restricted: true })).not.toBeNull();
    await store.delete(id, { restricted: true });
    expect(s3.objects.size).toBe(0);

    const kms = new S3EvidenceStore(s3, { bucket: "ev", kmsKeyId: "key-1", commands });
    await kms.put(id, jpegBytes(16), { restricted: false });
    expect(s3.sent.at(-1)!.input).toMatchObject({
      Key: `general/${id}.jpg`,
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: "key-1",
    });
  });

  test("other errors propagate", async () => {
    const store = new S3EvidenceStore(
      {
        send: async () => {
          throw Object.assign(new Error("denied"), { name: "AccessDenied" });
        },
      },
      { bucket: "ev", commands },
    );
    await expect(store.get(randomUUID(), { restricted: false })).rejects.toThrow("denied");
  });
});

describe("Turnstile verifier", () => {
  const respond = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("uses siteverify with the secret, token and IP", async () => {
    let seen: { url: string; body: string } | null = null;
    const fetchSpy = (async (url: string, init: RequestInit) => {
      seen = { url, body: String(init.body) };
      return new Response(JSON.stringify({ success: true }));
    }) as unknown as typeof fetch;
    const verify = createTurnstileVerifier({ secret: "1x0000000000000000000000000000000AA", production: true, fetch: fetchSpy });
    expect(await verify("tok", "203.0.113.9")).toBe(true);
    expect(seen!.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(seen!.body).toContain("secret=1x0000000000000000000000000000000AA");
    expect(seen!.body).toContain("response=tok");
    expect(seen!.body).toContain("remoteip=203.0.113.9");
  });

  test("fails closed on a failed check, a missing token, HTTP errors and network errors", async () => {
    const secret = "2x0000000000000000000000000000000AA";
    expect(await createTurnstileVerifier({ secret, production: true, fetch: respond({ success: false }) })("t", null)).toBe(false);
    expect(await createTurnstileVerifier({ secret, production: true, fetch: respond({ success: true }) })(undefined, null)).toBe(false);
    expect(await createTurnstileVerifier({ secret, production: true, fetch: respond({}, 500) })("t", null)).toBe(false);
    const broken = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await createTurnstileVerifier({ secret, production: true, fetch: broken })("t", null)).toBe(false);
  });

  test("without a secret: refuse in production, allow in development", async () => {
    expect(await createTurnstileVerifier({ production: true })("t", null)).toBe(false);
    expect(await createTurnstileVerifier({ production: false })(undefined, null)).toBe(true);
  });
});
