import { expect, test, type Stranger } from "./fixtures";
import { E2E_ADMIN_TOKEN } from "./adminToken";
import { expectMatchPrompt, onboard } from "./helpers";

/**
 * The gender filter costs coins: picking anything but "Everyone" opens the
 * unlock sheet, a pack is bought through the fake Razorpay (RAZORPAY_FAKE on
 * the backend, window.__chizzyFakeCheckout in the page), the filter is
 * unlocked for a week and the queue honours it. With the flag off the picker
 * is free. Needs the servers Playwright starts (admin token, fake gateway).
 */

/** Stands in for Razorpay Checkout: pays every order at once with the fake gateway's signature. */
async function installFakeCheckout(s: Stranger): Promise<void> {
  await s.context.addInitScript(() => {
    window.__chizzyFakeCheckout = async (order) => ({
      status: "paid",
      paymentId: `pay_e2e_${order.orderId.slice(-8)}`,
      signature: "fake-signature",
    });
  });
}

async function openSettings(s: Stranger) {
  await s.page.getByRole("button", { name: "Settings" }).click();
  const dialog = s.page.getByRole("dialog", { name: "Chat Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function pickGender(s: Stranger, label: string) {
  await s.page.locator("#settings-gender").click();
  await s.page.getByRole("option", { name: label, exact: true }).click();
}

async function setPremiumFlag(apiUrl: string, enabled: boolean) {
  const res = await fetch(`${apiUrl}/admin/api/flags`, {
    method: "PUT",
    headers: { authorization: `Bearer ${E2E_ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ premium_filters_enabled: enabled }),
  });
  expect(res.status, "flag update accepted").toBe(200);
}

test("picking a gender opens the unlock sheet; buying a pack and unlocking a week lets the filter save and match", async ({
  openStranger,
  apiUrl,
  acceptTimeoutMs,
}) => {
  test.skip(!apiUrl, "needs the fake Razorpay backend Playwright starts");
  const a = await openStranger("Arjun");
  await installFakeCheckout(a);
  await onboard(a, { gender: "Male", topics: ["books"] });
  await expect(a.page.getByTestId("status-waiting")).toBeVisible();

  await openSettings(a);
  await expect(a.page.getByTestId("gender-lock"), "the picker shows the coin lock").toBeVisible();
  await pickGender(a, "Female");
  const sheet = a.page.getByTestId("unlock-sheet");
  await expect(sheet).toBeVisible();
  await expect(a.page.locator("#settings-gender"), "nothing was saved").toHaveText("Everyone");
  await expect(a.page.getByTestId("wallet-coins")).toHaveText("0 coins");
  await expect(a.page.getByTestId("unlock-7"), "a week costs 700").toBeDisabled();

  await a.page.getByTestId("buy-week").click();
  await expect(a.page.getByTestId("wallet-coins")).toHaveText("700 coins");
  await expect(a.page.getByTestId("premium-feedback")).toHaveText("Coins added to your wallet.");

  await a.page.getByTestId("unlock-7").click();
  await expect(a.page.getByTestId("wallet-coins")).toHaveText("0 coins");
  await expect(a.page.getByTestId("unlock-status")).toContainText("Gender filter on until");
  await a.page.getByTestId("unlock-close").click();
  await expect(sheet).toBeHidden();

  await expect(a.page.getByTestId("gender-lock")).toBeHidden();
  await pickGender(a, "Female");
  await expect(a.page.getByRole("dialog", { name: "Chat Settings" }).getByRole("status")).toContainText("Saved");
  await expect(a.page.locator("#settings-gender")).toHaveText("Female");
  await a.page.getByRole("button", { name: "Close settings" }).click();

  // The queue honours the filter: a woman who is open to everyone matches Arjun.
  const b = await openStranger("Bela", { screen: { width: 1366, height: 768 } });
  await onboard(b, { gender: "Female", topics: ["books"] });
  await expectMatchPrompt(a.page, "Bela", acceptTimeoutMs);
  await expectMatchPrompt(b.page, "Arjun", acceptTimeoutMs);
});

test("with premium_filters_enabled off the picker is free", async ({ openStranger, apiUrl }) => {
  test.skip(!apiUrl, "needs the admin API of the backend Playwright starts");
  await setPremiumFlag(apiUrl!, false);
  try {
    const a = await openStranger("Chitra");
    await onboard(a, { gender: "Female", topics: ["art"] });
    await openSettings(a);
    await expect(a.page.getByTestId("gender-lock")).toHaveCount(0);
    await pickGender(a, "Male");
    await expect(a.page.getByRole("dialog", { name: "Chat Settings" }).getByRole("status")).toContainText("Saved");
    await expect(a.page.getByTestId("unlock-sheet")).toHaveCount(0);
    await expect(a.page.locator("#settings-gender")).toHaveText("Male");
  } finally {
    await setPremiumFlag(apiUrl!, true);
  }
});
