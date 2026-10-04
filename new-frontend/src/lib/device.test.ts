import { beforeEach, describe, expect, it } from "vitest";
import { DEVICE_ID_KEY, getDeviceId, randomUuid, resetDeviceIdCacheForTests } from "./device";
import { helloSchema } from "./protocol";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function throwingStorage(): Storage {
  const fail = () => {
    throw new Error("SecurityError");
  };
  return {
    length: 0,
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}

describe("getDeviceId", () => {
  beforeEach(() => {
    localStorage.clear();
    resetDeviceIdCacheForTests();
  });

  it("creates a uuid and persists it in localStorage", () => {
    const id = getDeviceId();
    expect(id).toMatch(UUID_V4);
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBe(id);
  });

  it("returns the same id on later calls and after a reload", () => {
    const first = getDeviceId();
    resetDeviceIdCacheForTests();
    expect(getDeviceId()).toBe(first);
  });

  it("replaces a corrupted stored value", () => {
    localStorage.setItem(DEVICE_ID_KEY, "not-a-uuid");
    const id = getDeviceId();
    expect(id).toMatch(UUID_V4);
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBe(id);
  });

  it("falls back to a stable in-memory id when storage throws", () => {
    const storage = throwingStorage();
    const a = getDeviceId(storage);
    const b = getDeviceId(storage);
    expect(a).toMatch(UUID_V4);
    expect(b).toBe(a);
  });

  it("works without any storage", () => {
    expect(getDeviceId(null)).toBe(getDeviceId(null));
  });

  it("produces ids the server accepts", () => {
    const parsed = helloSchema.shape.deviceId.safeParse(getDeviceId());
    expect(parsed.success).toBe(true);
  });
});

describe("randomUuid", () => {
  it("falls back to getRandomValues when randomUUID is missing", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      expect(randomUuid()).toMatch(UUID_V4);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });
});
