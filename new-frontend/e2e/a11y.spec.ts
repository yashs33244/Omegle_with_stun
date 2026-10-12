import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Result } from "axe-core";
import { devices, type Page } from "@playwright/test";
import { expect, test, type Stranger } from "./fixtures";
import { acceptMatch, expectMatchPrompt, onboard, openChat, passGate } from "./helpers";

/**
 * Runs axe-core (WCAG 2.1 AA) over every screen a stranger meets, on a phone
 * and on a desktop viewport. Serious and critical violations fail the test;
 * moderate ones are printed so they show up in the run log. Each audit is
 * also written to $A11Y_REPORT_DIR (default: a fresh chizzy-a11y-* directory
 * under the OS temp dir, logged on first use) as JSON.
 *
 * The second half checks the keyboard contract of the shared sheets: Escape
 * closes, focus returns to the opener, the dialog is named by its title.
 */

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
let reportDir: string | undefined;

/** $A11Y_REPORT_DIR, or a private directory created once per worker. */
function reportDirectory(): string {
  if (!reportDir) {
    reportDir = process.env.A11Y_REPORT_DIR || mkdtempSync(join(tmpdir(), "chizzy-a11y-"));
    mkdirSync(reportDir, { recursive: true });
    console.log(`axe reports: ${reportDir}`);
  }
  return reportDir;
}

const VIEWPORTS = {
  "pixel-7": devices["Pixel 7"].viewport,
  desktop: { width: 1280, height: 800 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;

/** One line per violation: rule, impact, help and the first few target selectors. */
function describeViolations(violations: Result[]): string {
  return violations
    .map((v) => {
      const targets = v.nodes
        .slice(0, 5)
        .map((n) => n.target.join(" "))
        .join(" | ");
      return `[${v.impact}] ${v.id}: ${v.help} (${v.helpUrl})\n    ${targets}`;
    })
    .join("\n");
}

/** Audits the current page state; fails on serious/critical, logs moderate, writes the JSON. */
async function audit(page: Page, viewport: ViewportName, state: string): Promise<void> {
  // Sheets fade and slide in; axe reads colours mid-animation as low contrast. Spinners loop forever, so skip them.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  writeFileSync(
    join(reportDirectory(), `axe-${viewport}-${state}.json`),
    JSON.stringify({ url: page.url(), viewport, state, violations: results.violations, incomplete: results.incomplete }, null, 2),
  );
  const moderate = results.violations.filter((v) => v.impact === "moderate" || v.impact === "minor");
  if (moderate.length) console.log(`axe ${viewport}/${state} moderate+minor:\n${describeViolations(moderate)}`);
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(describeViolations(blocking), `${viewport}/${state}: serious or critical axe violations`).toBe("");
}

/** The data-testid of the focused element (or its tag name), and whether the document has focus. */
function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    const name = el ? el.getAttribute("data-testid") || el.tagName.toLowerCase() : "none";
    return document.hasFocus() ? name : `${name} (document unfocused)`;
  });
}

/** A stranger on the given viewport; the fixture always opens desktop-sized contexts. */
async function openOn(
  openStranger: (name: string, options?: { screen?: { width: number; height: number } }) => Promise<Stranger>,
  name: string,
  viewport: ViewportName,
  screen?: { width: number; height: number },
): Promise<Stranger> {
  const s = await openStranger(name, screen ? { screen } : undefined);
  await s.page.setViewportSize(VIEWPORTS[viewport]);
  return s;
}

for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
  test.describe(viewport, () => {
    test("gate, start screen, settings and profile sheets, legal page, admin login", async ({ openStranger }) => {
      const s = await openOn(openStranger, "Ira", viewport);
      const { page } = s;

      await page.goto("/");
      await expect(page.getByTestId("gate-form")).toBeVisible();
      await audit(page, viewport, "gate");

      await passGate(s);
      await expect(page.getByTestId("start-chat")).toBeEnabled();
      await audit(page, viewport, "start");

      await page.getByTestId("open-settings").click();
      await expect(page.getByTestId("start-settings")).toBeVisible();
      await audit(page, viewport, "settings-sheet");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("start-settings")).toBeHidden();
      await expect.poll(() => focused(page), "Escape hands focus back to the opener").toBe("open-settings");

      await page.getByTestId("edit-profile").click();
      await expect(page.getByTestId("profile-editor")).toBeVisible();
      await audit(page, viewport, "profile-sheet");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("profile-editor")).toBeHidden();
      await expect.poll(() => focused(page), "Escape hands focus back to the opener").toBe("edit-profile");

      await page.goto("/guidelines");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await audit(page, viewport, "legal-guidelines");

      await page.goto("/admin");
      await expect(page.getByLabel("Admin token")).toBeVisible();
      await audit(page, viewport, "admin-login");
    });

    test("waiting, match card, in-call with the chat sheet open", async ({ openStranger, acceptTimeoutMs }) => {
      const a = await openOn(openStranger, "Asha", viewport);
      const b = await openOn(openStranger, "Bir", viewport, { width: 1366, height: 768 });

      await onboard(a, { gender: "Female", topics: ["music"] });
      await expect(a.page.getByTestId("status-waiting")).toBeVisible();
      await audit(a.page, viewport, "waiting");

      await onboard(b, { gender: "Male", topics: ["music"] });
      await expectMatchPrompt(a.page, "Bir", acceptTimeoutMs);
      await expect(a.page.getByTestId("match-card")).toBeVisible();
      await audit(a.page, viewport, "match-card");

      await acceptMatch(a, b, acceptTimeoutMs);
      await openChat(a.page);
      await audit(a.page, viewport, "in-call-chat");
    });

    test("the unlock sheet", async ({ openStranger, apiUrl }) => {
      test.skip(!apiUrl, "needs the premium flag of the backend Playwright starts");
      const a = await openOn(openStranger, "Chitra", viewport);
      await onboard(a, { gender: "Female", topics: ["art"] });
      await expect(a.page.getByTestId("status-waiting")).toBeVisible();

      await a.page.getByRole("button", { name: "Settings" }).click();
      const dialog = a.page.getByRole("dialog", { name: "Chat Settings" });
      await expect(dialog).toBeVisible();
      await a.page.locator("#settings-gender").click();
      await a.page.getByRole("option", { name: "Male", exact: true }).click();
      await expect(a.page.getByTestId("unlock-sheet")).toBeVisible();
      await audit(a.page, viewport, "unlock-sheet");
    });
  });
}
