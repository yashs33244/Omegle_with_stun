/**
 * Test-only switches for the e2e suite. They exist only in builds made with
 * VITE_E2E=1 (Playwright sets it for its own frontend builds). In every other
 * build `import.meta.env.VITE_E2E` is replaced at build time, this returns the
 * production defaults and the override branch is dropped from the bundle.
 *
 * Why: Chrome's fake camera shows a test pattern, not a face, so the real face
 * gate would pause every e2e call. A test that checks the face gate itself sets
 * `window.__chizzyE2E = { faceGate: "real" }` in an init script.
 */
export interface ModerationTestOverrides {
  /** "off" skips the face gate entirely. */
  faceGate: "real" | "off";
  /** "pass" treats every frame and photo as safe without running the classifier. */
  nsfw: "real" | "pass";
}

const PRODUCTION: ModerationTestOverrides = { faceGate: "real", nsfw: "real" };

export function moderationOverrides(): ModerationTestOverrides {
  if (import.meta.env.VITE_E2E !== "1") return PRODUCTION;
  const fromPage = (globalThis as { __chizzyE2E?: Partial<ModerationTestOverrides> }).__chizzyE2E;
  return { faceGate: "off", nsfw: "real", ...fromPage };
}
