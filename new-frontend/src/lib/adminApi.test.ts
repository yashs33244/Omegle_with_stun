import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_TOKEN_KEY, AdminApiError, createAdminApi, loadAdminToken, saveAdminToken } from "./adminApi";
import { FLAG_DEFAULTS } from "./protocol";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("createAdminApi", () => {
  it("sends the bearer token to /admin/api on the configured origin", async () => {
    const fetch = vi.fn(async () => json({ reports: [] }));
    const api = createAdminApi({ token: "secret", baseUrl: "https://api.example/", fetch });
    await expect(api.listReports()).resolves.toEqual([]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/admin/api/queue");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer secret");
    expect(init.credentials).toBe("omit");
  });

  it("lists the whole open queue plus recently closed reports, each once", async () => {
    const open = [{ id: "a", status: "open" }, { id: "b", status: "acknowledged" }];
    const recent = [{ id: "c", status: "dismissed" }, { id: "a", status: "open" }];
    const fetch = vi.fn(async (url: string) => json(url.endsWith("?status=all") ? recent : open));
    const api = createAdminApi({ token: "t", baseUrl: "http://x", fetch: fetch as never });
    expect((await api.listReports()).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([
      "http://x/admin/api/queue",
      "http://x/admin/api/queue?status=all",
    ]);
  });

  it("accepts bare arrays as well as wrapped lists", async () => {
    const api = createAdminApi({ token: "t", fetch: vi.fn(async () => json([])) });
    await expect(api.listAppeals()).resolves.toEqual([]);
  });

  it("throws an unauthorized error on 401 with the server message", async () => {
    const api = createAdminApi({ token: "bad", fetch: vi.fn(async () => json({ error: "unauthorized" }, 401)) });
    const err = await api.listTakedowns().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect((err as AdminApiError).unauthorized).toBe(true);
    expect((err as AdminApiError).message).toBe("unauthorized");
  });

  it("posts report actions and returns the CSAM packet when the server includes it", async () => {
    const packet = { reportId: "r1", generatedAt: 1 };
    const fetch = vi.fn(async () => json({ ok: true, packet }));
    const api = createAdminApi({ token: "t", baseUrl: "http://x", fetch });
    await expect(api.actOnReport("r1", { action: "escalate_csam" })).resolves.toEqual({ packet });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://x/admin/api/reports/r1/action");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ action: "escalate_csam" });
  });

  it("validates flags in both directions", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? json({ flags: JSON.parse(init.body as string) }) : json(FLAG_DEFAULTS),
    );
    const api = createAdminApi({ token: "t", fetch: fetch as never });
    const flags = await api.getFlags();
    expect(flags).toEqual(FLAG_DEFAULTS);
    await expect(api.setFlags({ ...flags, matching_enabled: false })).resolves.toMatchObject({ matching_enabled: false });
    await expect(api.setFlags({ ...flags, blocked_countries: "gb" })).rejects.toThrow();

    const bad = createAdminApi({ token: "t", fetch: vi.fn(async () => json({ flags: { nope: 1 } })) });
    await expect(bad.getFlags()).rejects.toBeInstanceOf(AdminApiError);
  });

  it("returns the evidence frame as an object URL or a data URL", async () => {
    const create = vi.fn(() => "blob:frame");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const img = createAdminApi({
      token: "t",
      fetch: vi.fn(async () => new Response(new Blob(["x"]), { headers: { "Content-Type": "image/jpeg" } })),
    });
    const frame = await img.getReportFrame("r1");
    expect(frame?.src).toBe("blob:frame");
    frame?.revoke();
    expect(revoke).toHaveBeenCalledWith("blob:frame");

    const data = createAdminApi({ token: "t", fetch: vi.fn(async () => json({ frame: "data:image/jpeg;base64,AA" })) });
    expect((await data.getReportFrame("r1"))?.src).toBe("data:image/jpeg;base64,AA");
    vi.unstubAllGlobals();
  });

  it("reports a network failure as a readable error", async () => {
    const api = createAdminApi({
      token: "t",
      fetch: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    await expect(api.listAudit()).rejects.toThrow("Cannot reach the server.");
  });
});

describe("admin token storage", () => {
  it("lives in sessionStorage only", () => {
    saveAdminToken("abc");
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBe("abc");
    expect(localStorage.length).toBe(0);
    expect(loadAdminToken()).toBe("abc");
    saveAdminToken(null);
    expect(loadAdminToken()).toBeNull();
  });
});
