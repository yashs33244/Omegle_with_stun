import { expect, test } from "./fixtures";
import { expectMatchPrompt, expectRemoteVideoPlaying, onboard } from "./helpers";

test("two strangers onboard, match, accept and see each other's video", async ({
  openStranger,
  acceptTimeoutMs,
  apiUrl,
}) => {
  const ava = await openStranger("Ava");
  const ben = await openStranger("Ben");

  const response = await ava.page.goto("/");
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp, "the app is served with its production CSP").toContain("connect-src 'self'");
  if (apiUrl) expect(csp).toContain(new URL(apiUrl).origin.replace(/^http/, "ws"));

  // Ava takes a photo; Ben skips it. They only share "music".
  await onboard(ava, { photo: "capture", gender: "Female", topics: ["general", "music"] });
  await onboard(ben, { photo: "skip", gender: "Male", topics: ["music", "books"] });

  await expectMatchPrompt(ava.page, "Ben", acceptTimeoutMs);
  await expectMatchPrompt(ben.page, "Ava", acceptTimeoutMs);
  await expect(ben.page.getByRole("img", { name: "Ava's photo" }), "Ava's captured photo reaches Ben").toBeVisible();
  // Blurred on Ben's device until the on-device classifier passes it.
  await expect(ben.page.getByRole("img", { name: "Ava's photo" })).toHaveAttribute("data-photo-check", "safe");
  await expect(ben.page.getByTestId("match-prompt")).toContainText("Interested in");

  // The countdown runs.
  const countdown = ava.page.getByTestId("match-countdown");
  const first = parseInt((await countdown.textContent()) ?? "", 10);
  await expect.poll(async () => parseInt((await countdown.textContent()) ?? "", 10)).toBeLessThan(first);

  // Ava accepts first: Ben is told, Ava waits for him.
  await ava.page.getByTestId("match-accept").click();
  await expect(ava.page.getByText("Waiting for Ben to accept...")).toBeVisible();
  await expect(ben.page.getByText("Ava has accepted! Waiting for your response...")).toBeVisible();
  await ben.page.getByTestId("match-accept").click();

  await expectRemoteVideoPlaying(ava.page);
  await expectRemoteVideoPlaying(ben.page);
  await expect(ava.page.getByText("Connected:", { exact: false })).toBeVisible();
});
