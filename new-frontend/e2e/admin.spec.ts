import { expect, test } from "./fixtures";
import { FLAG_DEFAULTS, type AdminReport } from "../src/lib/protocol";

/**
 * The console against a mocked /admin/api (the real endpoints come from the
 * enforcement lane). Checks the lazy chunk loads under the production CSP,
 * the token flow, and that evidence is blurred until the reviewer unblurs it.
 */
const NOW = Date.now();
const H = 3_600_000;
// A 1x1 white JPEG.
const FRAME =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=";

const REPORTS: AdminReport[] = [
  {
    id: "r-low",
    createdAt: NOW - H,
    reason: "spam",
    severity: "low",
    status: "open",
    roomId: "66666666-6666-4666-8666-666666666666",
    reporter: "rep",
    reported: "dev",
    reporterWeight: 0.5,
    details: null,
    hasFrame: false,
    chat: [],
    restricted: false,
    nsfwScore: null,
    ackDueAt: NOW + 20 * H,
    resolveDueAt: NOW + 300 * H,
    priorReportsAgainst: 0,
  },
  {
    id: "r-high",
    createdAt: NOW - 30 * H,
    reason: "nudity",
    severity: "high",
    status: "open",
    roomId: "77777777-7777-4777-8777-777777777777",
    reporter: "rep2",
    reported: "dev2",
    reporterWeight: 0.9,
    details: "flashed the camera",
    hasFrame: true,
    chat: [{ from: "reported", text: "look", ts: NOW - 30 * H }],
    restricted: false,
    nsfwScore: 0.97,
    ackDueAt: NOW - 6 * H,
    resolveDueAt: NOW + 40 * H,
    priorReportsAgainst: 2,
  },
];

test("admin console: token, severity-sorted queue, blurred evidence", async ({ openStranger }) => {
  const admin = await openStranger("Admin");
  const { page } = admin;
  const auth: (string | null)[] = [];
  await page.route("**/admin/api/**", async (route) => {
    const req = route.request();
    auth.push(req.headers()["authorization"] ?? null);
    const path = new URL(req.url()).pathname;
    const body =
      path === "/admin/api/reports"
        ? { reports: REPORTS }
        : path.endsWith("/frame")
          ? { frame: FRAME }
          : path === "/admin/api/flags"
            ? { flags: FLAG_DEFAULTS }
            : { ok: true };
    await route.fulfill({
      json: body,
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" },
    });
  });

  await page.goto("/admin");
  await page.getByLabel("Admin token").fill("e2e-token");
  await page.getByRole("button", { name: "Sign in" }).click();

  const items = page.getByTestId("queue-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute("data-severity", "high");
  await expect(items.nth(0).getByTestId("sla-chip")).toHaveAttribute("data-overdue", "true");
  expect(auth[0]).toBe("Bearer e2e-token");
  expect(await page.evaluate(() => sessionStorage.getItem("chizzy.adminToken"))).toBe("e2e-token");
  expect(await page.evaluate(() => localStorage.getItem("chizzy.adminToken"))).toBeNull();

  await items.nth(0).click();
  const img = page.getByTestId("evidence-image");
  await expect(img).toHaveAttribute("data-blurred", "true");
  await expect(img).toHaveCSS("filter", /blur\(16px\) grayscale\(1\)/);
  await page.getByRole("button", { name: "Unblur" }).click();
  await expect(img).toHaveAttribute("data-blurred", "false");
  await expect(img).toHaveCSS("filter", "none");

  await page.getByRole("button", { name: "Flags" }).click();
  await expect(page.getByLabel("Blocked countries")).toHaveValue(FLAG_DEFAULTS.blocked_countries);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Admin token")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("chizzy.adminToken"))).toBeNull();
});
