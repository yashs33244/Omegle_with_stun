/**
 * Compact signed tokens: "c1.<base64url(json)>.<base64url(HMAC-SHA256)>".
 *
 * Signed with a key derived from SESSION_SECRET. Verification also accepts
 * SESSION_SECRET_PREVIOUS so the secret can be rotated without logging
 * everyone out. The MAC is compared in constant time.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "c1";
const MAX_TOKEN_CHARS = 4096;

export const SESSION_TOKEN_TTL_MS = 24 * 60 * 60_000;
export const AGE_TOKEN_TTL_MS = 180 * 24 * 60 * 60_000;

export interface SessionTokenPayload {
  kind: "session";
  deviceId: string;
  /** ISO country the server saw when it issued the token, or null. */
  country: string | null;
  /** Epoch ms. */
  iat: number;
  exp: number;
}

export interface AgeTokenPayload {
  kind: "age";
  deviceId: string;
  over18: true;
  /** Terms version the user accepted; `iat` is when. */
  tosVersion: string;
  iat: number;
  exp: number;
}

type Payload = SessionTokenPayload | AgeTokenPayload;

function deriveKey(secret: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", secret).update("chizzy:token:v1").digest());
}

export class TokenSigner {
  private readonly keys: Uint8Array[];

  /** `secrets[0]` signs; every entry verifies (current first, then previous). */
  constructor(secrets: string[]) {
    if (secrets.length === 0) throw new Error("TokenSigner needs at least one secret");
    this.keys = secrets.map(deriveKey);
  }

  sign(payload: Payload): string {
    const body = `${PREFIX}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    return `${body}.${Buffer.from(this.mac(this.keys[0]!, body)).toString("base64url")}`;
  }

  verifySession(token: unknown, now: number): SessionTokenPayload | null {
    const p = this.verify(token, now);
    if (!p || p.kind !== "session") return null;
    if (typeof p.deviceId !== "string" || !(p.country === null || typeof p.country === "string")) return null;
    return p;
  }

  verifyAge(token: unknown, now: number): AgeTokenPayload | null {
    const p = this.verify(token, now);
    if (!p || p.kind !== "age") return null;
    if (typeof p.deviceId !== "string" || p.over18 !== true || typeof p.tosVersion !== "string") return null;
    return p;
  }

  private mac(key: Uint8Array, body: string): Uint8Array {
    return new Uint8Array(createHmac("sha256", key).update(body).digest());
  }

  private verify(token: unknown, now: number): Payload | null {
    if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX) return null;
    const body = `${parts[0]}.${parts[1]}`;
    const given = new Uint8Array(Buffer.from(parts[2]!, "base64url"));
    // Node's decoder skips junk characters; insist on the canonical encoding.
    if (Buffer.from(given).toString("base64url") !== parts[2]) return null;
    let valid = false;
    for (const key of this.keys) {
      const expected = this.mac(key, body);
      // Length is public (always 32 bytes for a real token); only the bytes need constant time.
      if (given.length === expected.length && timingSafeEqual(given, expected)) valid = true;
    }
    if (!valid) return null;
    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Payload;
    } catch {
      return null;
    }
    if (typeof payload !== "object" || payload === null) return null;
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return null;
    if (payload.exp <= now) return null;
    return payload;
  }
}
