import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

/** Options set per project in playwright.config.ts. */
export interface E2EOptions {
  /** Backend origin when Playwright started the servers itself; null in external mode. */
  apiUrl: string | null;
  /** The backend's MATCH_ACCEPT_TIMEOUT_MS. */
  acceptTimeoutMs: number;
}

/** One anonymous user: a separate browser context with its own camera and device id. */
export interface Stranger {
  name: string;
  context: BrowserContext;
  page: Page;
  /** Uncaught page errors, console errors and CSP violations seen so far. */
  problems: string[];
}

interface Fixtures {
  /** Opens a new stranger. Every stranger is closed and checked for problems after the test. */
  openStranger: (name: string) => Promise<Stranger>;
}

declare global {
  interface Window {
    /** Every stream getUserMedia handed to the app, oldest first. */
    __e2eStreams: MediaStream[];
    __e2eReportCsp: (text: string) => void;
  }
}

/** Runs before any app script in every page of a stranger. */
function instrumentPage() {
  const streams: MediaStream[] = [];
  Object.defineProperty(window, "__e2eStreams", { value: streams });
  const media = navigator.mediaDevices;
  if (media?.getUserMedia) {
    const getUserMedia = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      streams.push(stream);
      return stream;
    };
  }
  document.addEventListener("securitypolicyviolation", (e) => {
    void window.__e2eReportCsp(`${e.effectiveDirective} blocked ${e.blockedURI || "inline"}`);
  });
}

export const test = base.extend<Fixtures & E2EOptions>({
  apiUrl: [null, { option: true }],
  acceptTimeoutMs: [30000, { option: true }],

  openStranger: async ({ browser, baseURL }, use) => {
    const strangers: Stranger[] = [];

    await use(async (name) => {
      const context = await browser.newContext({
        baseURL,
        permissions: ["camera", "microphone"],
        viewport: { width: 1280, height: 800 },
      });
      const problems: string[] = [];
      await context.exposeBinding("__e2eReportCsp", (_source, text: string) => {
        problems.push(`CSP violation: ${text}`);
      });
      await context.addInitScript(instrumentPage);

      const page = await context.newPage();
      page.on("pageerror", (err) => problems.push(`uncaught: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") problems.push(`console.error: ${msg.text()}`);
      });

      const stranger: Stranger = { name, context, page, problems };
      strangers.push(stranger);
      return stranger;
    });

    for (const s of strangers) await s.context.close();
    for (const s of strangers) {
      expect(s.problems, `${s.name}: page errors, console errors or CSP violations`).toEqual([]);
    }
  },
});

export { expect };
