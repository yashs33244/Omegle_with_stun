/**
 * Anonymous per-browser device id. Coins, friends and blocks are keyed by it on
 * the server. It lives in localStorage; when storage is unavailable (private
 * mode, blocked cookies) an in-memory id is used for the lifetime of the page.
 */
export const DEVICE_ID_KEY = "chizzy:deviceId";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let memoryId: string | null = null;

/** RFC 4122 v4 uuid. crypto.randomUUID only exists in secure contexts. */
export function randomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function getDeviceId(storage: Storage | null = defaultStorage()): string {
  try {
    const stored = storage?.getItem(DEVICE_ID_KEY);
    if (stored && UUID_RE.test(stored)) return stored;
    const id = memoryId ?? randomUuid();
    storage?.setItem(DEVICE_ID_KEY, id);
    memoryId = id;
    return id;
  } catch {
    memoryId ??= randomUuid();
    return memoryId;
  }
}

/** Test helper: forget the in-memory fallback id. */
export function resetDeviceIdCacheForTests(): void {
  memoryId = null;
}
