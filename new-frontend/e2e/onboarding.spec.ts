import { expect, test, type Stranger } from "./fixtures";
import { passGate } from "./helpers";

/** Passes the gate and opens the profile dialog on the details step, with the empty name field focused. */
async function openDetails(s: Stranger): Promise<void> {
  const { page } = s;
  await passGate(s);
  const start = page.getByTestId("start-chat");
  await expect(start, "Start is enabled once the camera is ready").toBeEnabled();
  await start.click();
  await page.getByTestId("skip-photo").click();
  await expect(page.getByTestId("name-input")).toBeFocused();
}

test("a topic responds to the first click while the name is still empty", async ({ openStranger }) => {
  const stranger = await openStranger("Tara");
  const { page } = stranger;
  await openDetails(stranger);

  const music = page.getByTestId("topic-music");
  await expect(music).toHaveAttribute("aria-pressed", "false");
  await music.click();
  await expect(music, "the click was not lost to the name error appearing").toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Enter your name.")).toBeVisible();
});

test("gender opens on the first click while the name is still empty", async ({ openStranger }) => {
  const stranger = await openStranger("Gus");
  const { page } = stranger;
  await openDetails(stranger);

  const gender = page.getByTestId("gender-select");
  await gender.click();
  await expect(gender, "the click was not lost to the name error appearing").toHaveAttribute("aria-expanded", "true");
  await page.getByRole("option", { name: "Female", exact: true }).click();
  await expect(gender).toHaveText("Female");
});

test("a press outside the profile dialog closes an open dropdown before the dialog", async ({ openStranger }) => {
  const stranger = await openStranger("Ivy");
  const { page } = stranger;
  await openDetails(stranger);
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

test("the settings sheet holds country and language, and a press outside closes an open dropdown before the sheet", async ({
  openStranger,
}) => {
  const stranger = await openStranger("Jon");
  const { page } = stranger;
  await passGate(stranger);
  await expect(page.locator("#home-country"), "country is not on the start screen itself").toHaveCount(0);

  await page.getByTestId("open-settings").click();
  const sheet = page.getByTestId("start-settings");
  await expect(sheet).toBeVisible();
  const country = page.locator("#home-country");
  await country.click();
  await expect(page.getByRole("listbox", { name: "Country" })).toBeVisible();
  await page.getByRole("option", { name: /Germany/ }).click();
  await expect(country).toContainText("Germany");

  await page.locator("#home-language").click();
  await expect(page.getByRole("listbox", { name: "I speak" })).toBeVisible();
  // The dimmed backdrop, outside the sheet.
  await page.mouse.click(20, 20);
  await expect(page.getByRole("listbox", { name: "I speak" })).toBeHidden();
  await expect(sheet).toBeVisible();

  await page.mouse.click(20, 20);
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("start-chat")).toBeEnabled();
});
