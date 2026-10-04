import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** Opens the profile dialog on the details step, with the empty name field focused. */
async function openDetails(page: Page): Promise<void> {
  await page.goto("/");
  const start = page.getByTestId("start-chat");
  await expect(start, "Start is enabled once the camera is ready").toBeEnabled();
  await start.click();
  await page.getByTestId("skip-photo").click();
  await expect(page.getByTestId("name-input")).toBeFocused();
}

test("a topic responds to the first click while the name is still empty", async ({ openStranger }) => {
  const { page } = await openStranger("Tara");
  await openDetails(page);

  const music = page.getByTestId("topic-music");
  await expect(music).toHaveAttribute("aria-pressed", "false");
  await music.click();
  await expect(music, "the click was not lost to the name error appearing").toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Enter your name.")).toBeVisible();
});

test("gender opens on the first click while the name is still empty", async ({ openStranger }) => {
  const { page } = await openStranger("Gus");
  await openDetails(page);

  const gender = page.getByTestId("gender-select");
  await gender.click();
  await expect(gender, "the click was not lost to the name error appearing").toHaveAttribute("aria-expanded", "true");
  await page.getByRole("option", { name: "Female", exact: true }).click();
  await expect(gender).toHaveText("Female");
});
