/**
 * ADMIN_TOKEN of the backends Playwright starts (playwright.config.ts), so
 * specs can flip operator flags through /admin/api. CI exports its own value;
 * the fallback only ever reaches a local in-memory test backend.
 */
export const E2E_ADMIN_TOKEN = process.env.ADMIN_TOKEN || "e2e-admin-token-not-for-production";
