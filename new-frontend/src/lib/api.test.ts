import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api client", () => {
  it("posts the session request as JSON without cookies", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ok: true, sessionToken: "s", sessionExpiresAt: 1, ageToken: "a", ageExpiresAt: 2, country: null }),
    );
    const api = createApi(fetchImpl, "https://api.example/");
    const res = await api.createSession({
      deviceId: "8b0e7c2a-2f43-4c84-9a52-1b5b8f0d6f11",
      fingerprint: "a".repeat(64),
      age: { dob: "1990-01-01", attest18: true, tosVersion: "v" },
    });
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/api/session");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(String(init.body)).age.dob).toBe("1990-01-01");
  });

  it("returns refusals from error statuses as data", async () => {
    const api = createApi(async () => jsonResponse(403, { ok: false, error: "region_blocked" }), "");
    await expect(
      api.createSession({ deviceId: "x", fingerprint: "y", age: { ageToken: "t", tosVersion: "v" } }),
    ).resolves.toEqual({ ok: false, error: "region_blocked" });
  });

  it("maps a bare 429 to rate_limited", async () => {
    const api = createApi(async () => new Response("Too Many Requests", { status: 429 }), "");
    await expect(api.submitAppeal({ restrictionId: "r", deviceId: "d", text: "0123456789" })).resolves.toEqual({
      ok: false,
      error: "rate_limited",
    });
  });

  it("throws ApiError when the server cannot be reached or answers nonsense", async () => {
    const offline = createApi(async () => {
      throw new TypeError("Failed to fetch");
    }, "");
    await expect(offline.getConfig()).rejects.toBeInstanceOf(ApiError);
    const broken = createApi(async () => new Response("<html>", { status: 502 }), "");
    await expect(broken.getConfig()).rejects.toBeInstanceOf(ApiError);
  });

  it("returns null for a restriction that does not exist", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: "not_found" }));
    const api = createApi(fetchImpl, "");
    await expect(api.getRestriction("abc", "dev 1")).resolves.toBeNull();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/restrictions/abc?deviceId=dev%201");
  });
});
