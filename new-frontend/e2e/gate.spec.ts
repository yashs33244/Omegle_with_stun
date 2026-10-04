import { expect, test } from "./fixtures";
import { fillGateForm, passGate } from "./helpers";
import { fakeConfig, overrideConfig } from "./sessionApi";

/** A refused session may be answered with a 4xx, which Chromium logs as a failed resource. */
const REFUSED_REQUEST = /Failed to load resource: the server responded with a status of 4\d\d/;

/** Date of birth of someone who turned 15 this year, as [day, month, year]. */
function minorDob(): [string, string, string] {
  const now = new Date();
  return ["1", "1", String(now.getFullYear() - 15)];
}

test("the gate comes before the camera, and a returning visitor skips it", async ({ openStranger }) => {
  const ana = await openStranger("Ana");
  const { page } = ana;
  await page.goto("/");

  await expect(page.getByTestId("gate-form")).toBeVisible();
  await expect(page.getByRole("group", { name: "Date of birth" })).toBeVisible();
  await expect(page.getByTestId("site-footer")).toBeVisible();
  expect(await page.evaluate(() => window.__e2eStreams.length), "no camera prompt before the gate").toBe(0);

  const next = page.getByTestId("gate-continue");
  await expect(next).toBeDisabled();
  await fillGateForm(page, ["14", "2", "1995"]);
  await expect(next).toBeEnabled();
  await next.click();

  await expect(page.getByTestId("start-chat")).toBeEnabled();
  await expect(page.getByTestId("rules-reminder")).toContainText("18+ only");
  expect(await page.evaluate(() => window.__e2eStreams.length)).toBeGreaterThan(0);
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored, "the date of birth is not stored").not.toContain("1995");

  await page.reload();
  await expect(page.getByTestId("start-chat")).toBeVisible();
  await expect(page.getByTestId("gate-form")).toHaveCount(0);
});

test("an under-18 date of birth locks the device out", async ({ openStranger }) => {
  // Its own screen size keeps this device's fingerprint apart from the other strangers'.
  const kid = await openStranger("Kid", { screen: { width: 1111, height: 777 }, allowedProblems: [REFUSED_REQUEST] });
  const { page } = kid;
  await page.goto("/");
  await fillGateForm(page, minorDob());
  await page.getByTestId("gate-continue").click();

  const locked = page.getByTestId("gate-underage");
  await expect(locked).toBeVisible();
  await expect(locked.getByRole("heading")).toHaveText("Chizzy is for adults only");
  await expect(page.getByTestId("helplines")).toContainText("1098");
  await expect(page.getByTestId("helplines")).toContainText("988");

  await page.reload();
  await expect(locked).toBeVisible();
  await expect(page.getByTestId("dob-day")).toHaveCount(0);
  expect(await page.evaluate(() => window.__e2eStreams.length), "the camera never starts").toBe(0);
});

test("a blocked country sees that Chizzy is not available there yet", async ({ openStranger }) => {
  const tom = await openStranger("Tom", { country: "GB", allowedProblems: [REFUSED_REQUEST] });
  const { page } = tom;
  await page.goto("/");
  await fillGateForm(page, ["3", "8", "1990"]);
  await page.getByTestId("gate-continue").click();

  await expect(page.getByRole("heading", { name: "Chizzy is not available in your country yet" })).toBeVisible();
  await expect(page.getByTestId("start-chat")).toHaveCount(0);
});

test("outside staffed hours the app says when it opens and continues by itself", async ({ openStranger, apiUrl }) => {
  test.skip(!apiUrl, "needs the Playwright-managed backend to override its config");
  const nia = await openStranger("Nia");
  const opensAt = Date.now() + 4000;
  await overrideConfig(nia.context, apiUrl!, () =>
    Date.now() < opensAt
      ? fakeConfig({ matchingOpen: false, staffedHours: "8 pm to midnight IST", reopensAt: opensAt })
      : fakeConfig(),
  );
  const { page } = nia;
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Chizzy is open 8 pm to midnight IST" })).toBeVisible();
  await expect(page.getByTestId("reopens-countdown")).toHaveText(/^\d+ s$/);
  await expect(page.getByTestId("gate-form")).toHaveCount(0);

  // At the reopening time the page checks again and moves on to the gate.
  await expect(page.getByTestId("gate-form")).toBeVisible({ timeout: 15_000 });
  await passGate(nia);
});

test("legal pages are marked as drafts and the takedown form files a ticket", async ({ openStranger, apiUrl }) => {
  const lee = await openStranger("Lee");
  const { page } = lee;

  await page.goto("/privacy");
  await expect(page.getByTestId("legal-draft-notice")).toContainText("Draft, pending legal review");
  await expect(page.getByTestId("privacy-ip-disclosure")).toContainText("your partner's browser receives your IP address");
  await expect(page.getByTestId("retention-table")).toContainText("Date of birth");
  await expect(page.getByTestId("site-footer")).toBeVisible();

  for (const path of ["/terms", "/guidelines", "/safety", "/grievance", "/law-enforcement"]) {
    await page.goto(path);
    await expect(page.getByTestId("legal-draft-notice"), path).toBeVisible();
  }
  await page.goto("/safety");
  await expect(page.getByTestId("helplines-india")).toContainText("1930");
  await expect(page.getByTestId("helplines-us")).toContainText("988");

  // The takedown API belongs to the enforcement backend; answer it here so this checks the form alone.
  const sent: unknown[] = [];
  if (apiUrl) {
    await lee.context.route(`${apiUrl}/api/takedowns`, (route) => {
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, accept" } });
      }
      sent.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: JSON.stringify({ ok: true, ticketId: "TK-E2E-1" }),
      });
    });
  }
  await page.goto("/takedown");
  await page.getByLabel("Yes, it is me").check();
  await page.getByTestId("takedown-email").fill("person@example.com");
  await page.getByTestId("takedown-description").fill("A screenshot of my video call is being shared without my consent.");
  await page.getByTestId("takedown-good-faith").check();
  await expect(page.getByTestId("takedown-submit"), "enabled once the bot check passed").toBeEnabled();
  await page.getByTestId("takedown-submit").click();

  if (!apiUrl) return;
  await expect(page.getByTestId("takedown-ticket")).toHaveText("TK-E2E-1");
  expect(sent[0]).toMatchObject({
    kind: "ncii",
    contactEmail: "person@example.com",
    isAffectedPerson: true,
    goodFaithStatement: true,
    turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
  });
});
