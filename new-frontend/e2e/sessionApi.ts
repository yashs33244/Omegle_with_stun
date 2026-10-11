import type { BrowserContext, Route } from "@playwright/test";
import {
  FLAG_DEFAULTS,
  TOS_VERSION,
  sessionRequestSchema,
  type PublicConfig,
  type SessionResponse,
} from "../src/lib/protocol";

/**
 * Network helpers for the session gate in e2e runs.
 *
 * - The Turnstile script is replaced by a stub that behaves like Cloudflare's
 *   always-pass test site key (it hands out the documented dummy token), so
 *   the browser never loads third-party code during tests.
 * - Until the backend serves /api/session and /api/config, a fake of both is
 *   installed at the network layer. It follows protocol v3 closely enough for
 *   the frontend: Turnstile check, server-side 18+ from the date of birth,
 *   lockout, country blocklist (from the stranger's `country`), tokens.
 *   As soon as the backend answers /api/config, the real endpoints are used.
 */

/** Cloudflare's always-pass test site key and the dummy token its widget returns. */
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
/** Cloudflare's always-blocks test site key: the widget fails. */
export const TURNSTILE_BLOCK_SITE_KEY = "2x00000000000000000000AB";
export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const TURNSTILE_STUB = `
(() => {
  let next = 0;
  const widgets = new Map();
  const issue = (id) => {
    const w = widgets.get(id);
    if (!w) return;
    setTimeout(() => {
      if (!widgets.has(id)) return;
      if (w.opts.sitekey === ${JSON.stringify(TURNSTILE_BLOCK_SITE_KEY)}) w.opts["error-callback"]?.();
      else w.opts.callback?.(${JSON.stringify(TURNSTILE_DUMMY_TOKEN)});
    }, 50);
  };
  window.turnstile = {
    render(el, opts) {
      const id = "e2e-" + (++next);
      const box = document.createElement("div");
      box.textContent = "Turnstile test widget";
      box.setAttribute("data-e2e-turnstile", id);
      el.appendChild(box);
      widgets.set(id, { el: box, opts });
      issue(id);
      return id;
    },
    reset(id) { issue(id); },
    remove(id) { widgets.get(id)?.el.remove(); widgets.delete(id); },
    getResponse() { return ${JSON.stringify(TURNSTILE_DUMMY_TOKEN)}; },
  };
})();
`;

export async function stubTurnstile(context: BrowserContext): Promise<void> {
  await context.route("https://challenges.cloudflare.com/turnstile/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: TURNSTILE_STUB }),
  );
}

const probes = new Map<string, Promise<boolean>>();

/** True when the backend already serves the session API (protocol v3 /api/config). */
export function backendHasSessionApi(apiUrl: string): Promise<boolean> {
  let probe = probes.get(apiUrl);
  if (!probe) {
    probe = fetch(`${apiUrl}/api/config`)
      .then((res) => res.ok)
      .catch(() => false);
    probes.set(apiUrl, probe);
  }
  return probe;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept",
};

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function fakeConfig(overrides: Partial<PublicConfig> = {}): PublicConfig {
  return {
    tosVersion: TOS_VERSION,
    turnstileSiteKey: TURNSTILE_TEST_SITE_KEY,
    sentryDsn: null,
    posthogKey: null,
    posthogHost: null,
    banner: null,
    matchingOpen: true,
    staffedHours: null,
    reopensAt: null,
    defaultMode: FLAG_DEFAULTS.default_mode,
    privateModeEnabled: true,
    ...overrides,
  };
}

/** Devices the fake has locked out (under-18), shared by every stranger in the run. */
const lockedDevices = new Set<string>();

function isAdult(dob: string, now = new Date()): boolean {
  const [y, m, d] = dob.split("-").map(Number) as [number, number, number];
  const eighteenth = new Date(Date.UTC(y + 18, m - 1, d));
  return eighteenth.getTime() <= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function fakeSessionResponse(body: unknown, country: string | null): SessionResponse {
  const parsed = sessionRequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const req = parsed.data;
  if (req.turnstileToken !== TURNSTILE_DUMMY_TOKEN) return { ok: false, error: "turnstile_failed" };
  if (country && FLAG_DEFAULTS.blocked_countries.split(",").includes(country)) return { ok: false, error: "region_blocked" };
  if (lockedDevices.has(req.deviceId)) return { ok: false, error: "locked" };
  if (req.age.tosVersion !== TOS_VERSION) return { ok: false, error: "tos_outdated" };
  if ("dob" in req.age && !isAdult(req.age.dob)) {
    lockedDevices.add(req.deviceId);
    return { ok: false, error: "underage" };
  }
  if ("ageToken" in req.age && req.age.ageToken !== `age:${req.deviceId}`) return { ok: false, error: "age_token_invalid" };
  const now = Date.now();
  return {
    ok: true,
    sessionToken: `session:${req.deviceId}:${now}`,
    sessionExpiresAt: now + 24 * 3600_000,
    ageToken: `age:${req.deviceId}`,
    ageExpiresAt: now + 180 * 86_400_000,
    country,
  };
}

export interface SessionApiOptions {
  apiUrl: string;
  /** Country the "CDN" reports for this stranger (CF-IPCountry). */
  country: string | null;
}

/**
 * Installs the fake session API when the backend lacks it; otherwise only
 * adds the CF-IPCountry header the backend trusts in e2e (TRUST_CLOUDFLARE).
 */
export async function installSessionApi(context: BrowserContext, { apiUrl, country }: SessionApiOptions): Promise<void> {
  if (await backendHasSessionApi(apiUrl)) {
    if (country) {
      await context.route(`${apiUrl}/api/session`, (route) =>
        route.continue({ headers: { ...route.request().headers(), "cf-ipcountry": country } }),
      );
    }
    return;
  }
  await context.route(`${apiUrl}/api/config`, (route) => json(route, 200, fakeConfig()));
  await context.route(`${apiUrl}/api/session`, (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    // Refusals are answered with 200 and `ok: false`, so they do not log a failed request in the console.
    return json(route, 200, fakeSessionResponse(request.postDataJSON(), country));
  });
}

/** Serves a fixed /api/config to this stranger, whatever the backend says (for closed-hours tests). */
export async function overrideConfig(context: BrowserContext, apiUrl: string, config: () => PublicConfig): Promise<void> {
  await context.route(`${apiUrl}/api/config`, (route) => json(route, 200, config()));
}
