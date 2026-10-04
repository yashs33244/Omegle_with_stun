import { API_URL } from "./config";
import {
  flagsSchema,
  type AdminAppeal,
  type AdminAuditEntry,
  type AdminReport,
  type AdminReportAction,
  type AdminTakedown,
  type CsamReportPacket,
  type Flags,
} from "./protocol";

/**
 * Client for the admin API (/admin/api/*, Authorization: Bearer ADMIN_TOKEN).
 *
 * protocol.ts defines the payload types but not the routes, so the routes the
 * console expects are listed here in one place. List responses may be a bare
 * array or wrapped in an object ({ reports: [...] }); both are accepted.
 */
export const ADMIN_ROUTES = {
  reports: "/admin/api/reports",
  reportFrame: (id: string) => `/admin/api/reports/${encodeURIComponent(id)}/frame`,
  reportAction: (id: string) => `/admin/api/reports/${encodeURIComponent(id)}/action`,
  reportPacket: (id: string) => `/admin/api/reports/${encodeURIComponent(id)}/packet`,
  appeals: "/admin/api/appeals",
  appealDecision: (id: string) => `/admin/api/appeals/${encodeURIComponent(id)}/decision`,
  takedowns: "/admin/api/takedowns",
  takedownResolve: (id: string) => `/admin/api/takedowns/${encodeURIComponent(id)}/resolve`,
  flags: "/admin/api/flags",
  audit: "/admin/api/audit",
} as const;

export class AdminApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }

  /** The token was rejected: the console asks for it again. */
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface AdminApiOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Evidence frame for display: a data URL or an object URL the caller must revoke. */
export interface EvidenceImage {
  src: string;
  revoke: () => void;
}

function unwrap<T>(body: unknown, key: string): T {
  if (body && typeof body === "object" && !Array.isArray(body) && key in body) {
    return (body as Record<string, unknown>)[key] as T;
  }
  return body as T;
}

function list<T>(body: unknown, key: string): T[] {
  const value = unwrap<unknown>(body, key);
  if (!Array.isArray(value)) throw new AdminApiError(500, `Unexpected response: no ${key} list.`);
  return value as T[];
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const { message, error } = body as { message?: unknown; error?: unknown };
      if (typeof message === "string") return message;
      if (typeof error === "string") return error;
    }
  } catch {
    // Not JSON.
  }
  return `HTTP ${res.status}`;
}

export function createAdminApi({
  token,
  baseUrl = API_URL,
  // Wrapped: calling an unbound window.fetch throws "Illegal invocation".
  fetch: fetchImpl = (input, init) => globalThis.fetch(input, init),
}: AdminApiOptions) {
  const base = baseUrl.replace(/\/+$/, "");

  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { ...init, headers, credentials: "omit", cache: "no-store" });
    } catch {
      throw new AdminApiError(0, "Cannot reach the server.");
    }
    if (!res.ok) throw new AdminApiError(res.status, await errorMessage(res));
    return res;
  };

  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await request(path, init);
    return (await res.json()) as T;
  };

  const post = <T>(path: string, body: unknown, method = "POST") =>
    json<T>(path, { method, body: JSON.stringify(body) });

  return {
    async listReports(): Promise<AdminReport[]> {
      return list<AdminReport>(await json(ADMIN_ROUTES.reports), "reports");
    },

    /** Every call is an evidence access the server writes to the audit log. */
    async getReportFrame(id: string): Promise<EvidenceImage | null> {
      const res = await request(ADMIN_ROUTES.reportFrame(id));
      const type = res.headers.get("Content-Type") ?? "";
      if (type.startsWith("image/")) {
        const src = URL.createObjectURL(await res.blob());
        return { src, revoke: () => URL.revokeObjectURL(src) };
      }
      const frame = unwrap<unknown>(await res.json(), "frame");
      return typeof frame === "string" && frame.startsWith("data:image/") ? { src: frame, revoke: () => {} } : null;
    },

    async actOnReport(id: string, action: AdminReportAction): Promise<{ packet?: CsamReportPacket }> {
      const body = await post<unknown>(ADMIN_ROUTES.reportAction(id), action);
      const packet = unwrap<unknown>(body, "packet");
      return packet && typeof packet === "object" && "reportId" in packet ? { packet: packet as CsamReportPacket } : {};
    },

    async getCsamPacket(id: string): Promise<CsamReportPacket> {
      return unwrap<CsamReportPacket>(await json(ADMIN_ROUTES.reportPacket(id)), "packet");
    },

    async listAppeals(): Promise<AdminAppeal[]> {
      return list<AdminAppeal>(await json(ADMIN_ROUTES.appeals), "appeals");
    },

    async decideAppeal(id: string, decision: "uphold" | "overturn", note?: string): Promise<void> {
      await post(ADMIN_ROUTES.appealDecision(id), { decision, ...(note ? { note } : {}) });
    },

    async listTakedowns(): Promise<AdminTakedown[]> {
      return list<AdminTakedown>(await json(ADMIN_ROUTES.takedowns), "takedowns");
    },

    async resolveTakedown(id: string, resolution: string): Promise<void> {
      await post(ADMIN_ROUTES.takedownResolve(id), { resolution });
    },

    async getFlags(): Promise<Flags> {
      const parsed = flagsSchema.safeParse(unwrap(await json(ADMIN_ROUTES.flags), "flags"));
      if (!parsed.success) throw new AdminApiError(500, "The server sent flags this console does not understand.");
      return parsed.data;
    },

    async setFlags(flags: Flags): Promise<Flags> {
      const body = await post<unknown>(ADMIN_ROUTES.flags, flagsSchema.parse(flags), "PUT");
      const parsed = flagsSchema.safeParse(unwrap(body, "flags"));
      return parsed.success ? parsed.data : flags;
    },

    async listAudit(): Promise<AdminAuditEntry[]> {
      return list<AdminAuditEntry>(await json(ADMIN_ROUTES.audit), "entries");
    },
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;

export const ADMIN_TOKEN_KEY = "chizzy.adminToken";

/** The admin token lives in sessionStorage only: gone when the tab closes. */
export function loadAdminToken(): string | null {
  try {
    return window.sessionStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveAdminToken(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // Storage blocked: the token only lives in memory for this page.
  }
}
