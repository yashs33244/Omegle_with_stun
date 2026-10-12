import type { BrowserContext, Page } from "@playwright/test";
import { expect, test, type Stranger } from "./fixtures";
import { expectRemoteVideoPlaying, expectWaiting, onboard, passGate } from "./helpers";

/**
 * Instant mode, the safe-start blur, Next, Hide my IP, the face gate and the
 * in-app browser notice. The NSFW classifier runs for real on Chrome's fake
 * camera pattern; the face gate is off in e2e builds unless a test turns it
 * on (the fake camera has no face), see src/moderation/testHooks.ts.
 */

declare global {
  interface Window {
    __sawAcceptCard?: boolean;
    __chizzyE2E?: { faceGate?: "real" | "off"; nsfw?: "real" | "pass" };
  }
}

/** Records whether the accept card was ever on screen. */
async function watchForAcceptCard(page: Page) {
  await page.addInitScript(() => {
    window.__sawAcceptCard = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="match-prompt"]')) window.__sawAcceptCard = true;
    }).observe(document, { childList: true, subtree: true });
  });
}

/** Both strangers pick Instant and end up in a call without an accept card. */
async function startInstantCall(a: Stranger, b: Stranger) {
  await watchForAcceptCard(a.page);
  await watchForAcceptCard(b.page);
  await onboard(a, { mode: "instant" });
  await onboard(b, { mode: "instant" });
  for (const s of [a, b]) {
    await expect(s.page.getByTestId("remote-video")).toBeVisible();
    await expect(s.page.getByTestId("next-button")).toBeVisible();
  }
}

/** Rewrites call:start so the server appears to allow Hide my IP. */
async function allowPrivateMode(context: BrowserContext) {
  await context.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message === "string" && message.startsWith('42["call:start"')) {
        const [event, payload] = JSON.parse(message.slice(2)) as [string, Record<string, unknown>];
        ws.send(`42${JSON.stringify([event, { ...payload, privateModeAllowed: true }])}`);
        return;
      }
      ws.send(message);
    });
  });
}

/** Counts the rtc:signal frames this browser sends that carry an ICE candidate. */
async function countSentCandidates(context: BrowserContext): Promise<{ candidates: () => number }> {
  let candidates = 0;
  await context.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string" && message.startsWith('42["rtc:signal"') && message.includes('"candidate"')) candidates += 1;
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  return { candidates: () => candidates };
}

test("instant mode starts the call without an accept card, unblurs the partner after the check, and Next works", async ({
  openStranger,
}) => {
  const ava = await openStranger("Ava");
  const ben = await openStranger("Ben");
  await startInstantCall(ava, ben);

  // The partner's video starts blurred...
  await expect(ava.page.getByTestId("remote-video")).toHaveAttribute("data-blurred", "true");
  await expectRemoteVideoPlaying(ava.page);
  await expectRemoteVideoPlaying(ben.page);

  // ...and is shown once the on-device classifier passed three frames in a row.
  for (const s of [ava, ben]) {
    await expect(s.page.getByTestId("remote-video"), `${s.name}'s partner video unblurs`).toHaveAttribute(
      "data-blurred",
      "false",
      { timeout: 60_000 },
    );
    expect(await s.page.evaluate(() => window.__sawAcceptCard), `${s.name} never saw an accept card`).toBe(false);
  }

  await ava.page.getByTestId("next-button").click();
  await expectWaiting(ava.page, "skipped");
  await expectWaiting(ben.page, "partner-skipped");
});

test("Esc means Next during a call, but not while typing in the chat", async ({ openStranger }) => {
  const cy = await openStranger("Cy");
  const di = await openStranger("Di");
  await startInstantCall(cy, di);

  await cy.page.getByTestId("chat-toggle").click();
  await cy.page.getByTestId("chat-input").fill("hi");
  await cy.page.getByTestId("chat-input").press("Escape");
  await expect(cy.page.getByTestId("next-button"), "typing Esc in the chat does not skip").toBeVisible();

  await cy.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await cy.page.keyboard.press("Escape");
  await expectWaiting(cy.page, "skipped");
  await expectWaiting(di.page, "partner-skipped");
});

test("Hide my IP is offered in the call when the server allows it, and fails closed when it cannot apply", async ({
  openStranger,
}) => {
  const eve = await openStranger("Eve");
  const fay = await openStranger("Fay");
  await allowPrivateMode(eve.context);
  const fayUplink = await countSentCandidates(fay.context);
  // Fay asks for Hide my IP in the start screen's settings sheet; this e2e backend has no TURN relay to use.
  await passGate(fay);
  await fay.page.getByTestId("open-settings").click();
  await fay.page.getByTestId("hide-ip-toggle").click();
  await expect(fay.page.getByTestId("hide-ip-toggle")).toHaveAttribute("aria-checked", "true");
  await fay.page.getByTestId("settings-done").click();
  await expect(fay.page.getByTestId("start-settings")).toBeHidden();
  await watchForAcceptCard(eve.page);
  await watchForAcceptCard(fay.page);
  await onboard(eve, { mode: "instant" });
  await onboard(fay, { mode: "instant" });

  // No connection exists on Fay's side until she decides: no candidate has left her browser.
  const sheet = fay.page.getByTestId("private-unavailable-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Hide my IP is not available for this call");
  await expect(fay.page.getByTestId("private-unavailable")).toHaveCount(0);
  await expect(fay.page.getByTestId("private-badge")).toHaveCount(0);
  await fay.page.waitForTimeout(1_000);
  expect(fayUplink.candidates()).toBe(0);

  await fay.page.getByTestId("private-unavailable-continue").click();
  await expect(sheet).toBeHidden();
  await expect(fay.page.getByTestId("private-unavailable")).toBeVisible();
  for (const s of [eve, fay]) {
    await expect(s.page.getByTestId("remote-video")).toBeVisible();
    await expect(s.page.getByTestId("next-button")).toBeVisible();
  }
  await expect.poll(() => fayUplink.candidates()).toBeGreaterThan(0);

  const toggle = eve.page.getByTestId("hide-ip-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(eve.page.getByTestId("hide-ip")).toContainText("Your partner sees our relay, not your IP. Chizzy and Cloudflare still see it.");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(eve.page.getByTestId("hide-ip")).toContainText("Applies from your next call.");
  // This call keeps its direct path; nothing breaks.
  await expectRemoteVideoPlaying(eve.page);
});

test("Skip on the Hide my IP sheet leaves the match without ever connecting", async ({ openStranger }) => {
  const ian = await openStranger("Ian");
  const jo = await openStranger("Jo");
  const joUplink = await countSentCandidates(jo.context);
  await passGate(jo);
  await jo.page.getByTestId("open-settings").click();
  await jo.page.getByTestId("hide-ip-toggle").click();
  await jo.page.getByTestId("settings-done").click();
  await onboard(ian, { mode: "instant" });
  await onboard(jo, { mode: "instant" });
  await expect(jo.page.getByTestId("private-unavailable-sheet")).toBeVisible();
  await jo.page.getByTestId("private-unavailable-skip").click();
  await expect(jo.page.getByTestId("private-unavailable-sheet")).toBeHidden();
  await expectWaiting(jo.page, "skipped");
  await expectWaiting(ian.page, "partner-skipped");
  expect(joUplink.candidates()).toBe(0);
});

test("the face gate pauses the video when no face is in frame and the partner gets the placeholder", async ({
  openStranger,
}) => {
  const gus = await openStranger("Gus");
  const hal = await openStranger("Hal");
  // Real face detector for Gus; Chrome's fake camera shows a test pattern, not a face.
  await gus.page.addInitScript(() => {
    window.__chizzyE2E = { faceGate: "real" };
  });
  await startInstantCall(gus, hal);

  await expect(gus.page.getByTestId("face-paused")).toHaveText("Your face is out of frame, so your video is paused", {
    timeout: 60_000,
  });
  // Hal now receives the 320x240 placeholder instead of Gus's 640x480 camera.
  await expect
    .poll(() => hal.page.getByTestId("remote-video").evaluate((v: HTMLVideoElement) => v.videoWidth), {
      message: "Hal receives the placeholder",
      timeout: 30_000,
    })
    .toBe(320);
});

test("an in-app browser gets the open-in-browser notice before anything else", async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36 Instagram 339.0.0.12.91 Android",
    permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"],
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const notice = page.getByTestId("in-app-notice");
    await expect(notice).toContainText("You opened this link inside Instagram");
    await expect(page.getByTestId("open-in-chrome")).toHaveAttribute("href", /^intent:\/\/.*package=com\.android\.chrome/);
    await expect(page.getByTestId("start-chat")).toHaveCount(0);
    await page.getByTestId("copy-link").click();
    await expect(notice).toContainText("Link copied.");
    // Continuing lands on the age gate: the notice comes before it, not after.
    await page.getByRole("button", { name: "Continue here anyway" }).click();
    await expect(page.getByTestId("gate-form")).toBeVisible();
    await passGate({ name: "InApp", context, page, problems: [] });
  } finally {
    await context.close();
  }
});
