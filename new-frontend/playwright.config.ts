import { defineConfig } from "@playwright/test";
import type { E2EOptions } from "./e2e/fixtures";
import { E2E_ADMIN_TOKEN } from "./e2e/adminToken";

/**
 * Two modes:
 * - Default: Playwright starts the BUILT backend (Node) and a production
 *   preview of the frontend built against it. A second backend with a short
 *   accept window (and its own frontend build) serves the accept-timeout spec.
 * - External: E2E_BASE_URL points at a running stack (for example docker
 *   compose); no servers are started. The accept-timeout spec then uses
 *   E2E_TIMEOUT_BASE_URL (default E2E_BASE_URL) and waits for the stack's
 *   window, E2E_ACCEPT_TIMEOUT_MS (default 30000).
 *
 * In the default mode the ports come from E2E_API_PORT (default 3104) and
 * E2E_WEB_PORT (default 4173); the accept-timeout pair uses the next port of
 * each unless E2E_TIMEOUT_API_PORT or E2E_TIMEOUT_WEB_PORT is set. Pick other
 * ports to run beside another e2e run or a `vite preview` (which uses 4173).
 */
const EXTERNAL_URL = process.env.E2E_BASE_URL;
const CI = !!process.env.CI;

/** A TCP port from the environment, or the fallback when the variable is unset or empty. */
function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a TCP port number, got "${raw}"`);
  }
  return port;
}

const API_PORT = portFromEnv("E2E_API_PORT", 3104);
const WEB_PORT = portFromEnv("E2E_WEB_PORT", 4173);
const TIMEOUT_API_PORT = portFromEnv("E2E_TIMEOUT_API_PORT", API_PORT + 1);
const TIMEOUT_WEB_PORT = portFromEnv("E2E_TIMEOUT_WEB_PORT", WEB_PORT + 1);
/** Accept window of the dedicated accept-timeout backend. */
const SHORT_ACCEPT_TIMEOUT_MS = 3000;

type ProjectUse = E2EOptions & { baseURL: string };

const api = (port: number) => `http://localhost:${port}`;
const web = (port: number) => `http://localhost:${port}`;

const mainUse: ProjectUse = EXTERNAL_URL
  ? { baseURL: EXTERNAL_URL, apiUrl: null, acceptTimeoutMs: 30000 }
  : { baseURL: web(WEB_PORT), apiUrl: api(API_PORT), acceptTimeoutMs: 30000 };

const timeoutUse: ProjectUse = EXTERNAL_URL
  ? {
      baseURL: process.env.E2E_TIMEOUT_BASE_URL || EXTERNAL_URL,
      apiUrl: null,
      acceptTimeoutMs: Number(process.env.E2E_ACCEPT_TIMEOUT_MS || 30000),
    }
  : { baseURL: web(TIMEOUT_WEB_PORT), apiUrl: api(TIMEOUT_API_PORT), acceptTimeoutMs: SHORT_ACCEPT_TIMEOUT_MS };

const backendEnv = (port: number, acceptTimeoutMs: number) => ({
  PORT: String(port),
  NODE_ENV: "development",
  MATCH_ACCEPT_TIMEOUT_MS: String(acceptTimeoutMs),
  LOG_LEVEL: "warn",
  // Always the in-memory store, whatever the calling shell exports.
  REDIS_URL: "",
  // Cloudflare's Turnstile test keys: the always-pass site key and secret.
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
  // Lets a test pick its country with the CF-IPCountry header (e2e only).
  TRUST_CLOUDFLARE: "true",
  // Fake payment gateway (no HTTP, fixed signature) so premium.spec.ts can buy coins offline.
  RAZORPAY_FAKE: "true",
  // Lets specs flip operator flags (premium.spec.ts) through /admin/api.
  ADMIN_TOKEN: E2E_ADMIN_TOKEN,
});

/** Production build pointed at one backend, served by `vite preview` with the production security headers. */
const frontendServer = (port: number, apiPort: number) => ({
  command: `npx vite build --outDir dist-e2e/${port} --emptyOutDir && npx vite preview --config e2e/vite.preview.config.ts --outDir dist-e2e/${port} --port ${port} --strictPort`,
  url: web(port),
  // VITE_E2E enables the moderation test switches (src/moderation/testHooks.ts);
  // an empty VITE_PROBE_STUN_URLS keeps the pre-flight probe off third-party STUN servers.
  env: { VITE_API_URL: api(apiPort), BROWSERSLIST_IGNORE_OLD_DATA: "1", VITE_E2E: "1", VITE_PROBE_STUN_URLS: "" },
  reuseExistingServer: false,
  timeout: 120_000,
  stdout: "ignore" as const,
  stderr: "pipe" as const,
});

export default defineConfig<E2EOptions>({
  testDir: "./e2e",
  // Every test pairs two strangers on one shared backend; parallel tests would match each other.
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /accept-timeout\.spec\.ts/,
      use: mainUse,
    },
    {
      name: "accept-timeout",
      testMatch: /accept-timeout\.spec\.ts/,
      use: timeoutUse,
    },
  ],
  // Started one after another, so the second backend reuses the first build.
  webServer: EXTERNAL_URL
    ? undefined
    : [
        {
          command: "cd ../backend && bun run build && node dist/index.js",
          url: `${api(API_PORT)}/healthz`,
          env: backendEnv(API_PORT, 30000),
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          command: "node ../backend/dist/index.js",
          url: `${api(TIMEOUT_API_PORT)}/healthz`,
          env: backendEnv(TIMEOUT_API_PORT, SHORT_ACCEPT_TIMEOUT_MS),
          reuseExistingServer: false,
          timeout: 60_000,
          stdout: "pipe",
          stderr: "pipe",
        },
        frontendServer(WEB_PORT, API_PORT),
        frontendServer(TIMEOUT_WEB_PORT, TIMEOUT_API_PORT),
      ],
});
