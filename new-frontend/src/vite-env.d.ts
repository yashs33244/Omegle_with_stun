/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Socket.IO origin of the backend, e.g. https://chizzyapi.itsyash.space */
  readonly VITE_API_URL?: string;
  /** Public origin of the site without a trailing slash, e.g. https://chizzy.itsyash.space (set by vite.config.ts). */
  readonly VITE_SITE_URL?: string;
  /** "1" only in the Playwright e2e builds: enables the moderation test switches (src/moderation/testHooks.ts). */
  readonly VITE_E2E?: string;
  /** Comma-separated STUN URLs for the pre-flight network probe; empty disables STUN in the probe. */
  readonly VITE_PROBE_STUN_URLS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
