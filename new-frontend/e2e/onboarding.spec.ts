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

test("a press outside the profile dialog closes an open dropdown before the dialog", async ({ openStranger }) => {
  const { page } = await openStranger("Ivy");
  await openDetails(page);
  const dialog = page.getByRole("dialog");
  const gender = page.getByTestId("gender-select");

  await gender.click();
  await expect(page.getByRole("listbox", { name: "Gender" })).toBeVisible();
  // The dimmed overlay, outside the dialog box.
  await page.mouse.click(20, 20);
  await expect(page.getByRole("listbox", { name: "Gender" })).toBeHidden();
  await expect(gender).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeVisible();

  await page.mouse.click(20, 20);
  await expect(dialog).toBeHidden();
});

test("an open home dropdown closes when Start is clicked", async ({ openStranger }) => {
  const { page } = await openStranger("Jon");
  await page.goto("/");
  const start = page.getByTestId("start-chat");
  await expect(start).toBeEnabled();

  const country = page.locator("#home-country");
  await country.click();
  await expect(page.getByRole("listbox", { name: "Country" })).toBeVisible();
  await start.click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Country" })).toBeHidden();
  await expect(country).toHaveAttribute("aria-expanded", "false");
});
