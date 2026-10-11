/**
 * Spark prompts and live captions between two strangers.
 *
 * Captions use the browser's SpeechRecognition, which has no speech service
 * in a test browser, so a fake is injected: the sender's fake "hears"
 * "hello there"; the receiver's fake hears nothing. SPARK_SHOTS_DIR (optional)
 * receives phone-viewport screenshots of the Spark card and the captions overlay.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { devices, type BrowserContext, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { startCall } from "./helpers";

const SHOTS_DIR = process.env.SPARK_SHOTS_DIR;

/** Installs a SpeechRecognition stand-in that emits the given transcripts once started. */
function fakeSpeech(context: BrowserContext, transcripts: { text: string; final: boolean; afterMs: number }[]) {
  return context.addInitScript((script) => {
    class FakeSpeechRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        for (const { text, final, afterMs } of script) {
          setTimeout(() => {
            const result = { isFinal: final, length: 1, 0: { transcript: text } };
            this.onresult?.({ resultIndex: 0, results: { length: 1, 0: result } });
          }, afterMs);
        }
      }
      stop() {}
      abort() {}
    }
    Object.defineProperty(window, "webkitSpeechRecognition", { value: FakeSpeechRecognition, configurable: true });
    Object.defineProperty(window, "SpeechRecognition", { value: FakeSpeechRecognition, configurable: true });
  }, transcripts);
}

async function turnCaptionsOn(page: Page): Promise<void> {
  const toggle = page.getByTestId("captions-toggle");
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const ok = page.getByTestId("captions-notice-ok");
  if (await ok.isVisible()) await ok.click();
}

async function phoneShot(page: Page, device: "Pixel 7" | "iPhone 14", name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.setViewportSize(devices[device].viewport);
  await page.screenshot({ path: join(SHOTS_DIR, `${name}-${device.replace(/\s+/g, "-").toLowerCase()}.png`) });
}

test("both strangers see the same Spark prompt within a second, then share one cooldown", async ({
  openStranger,
  acceptTimeoutMs,
}) => {
  const gia = await openStranger("Gia");
  const hal = await openStranger("Hal");
  await startCall(gia, hal, acceptTimeoutMs);

  const giaCard = gia.page.getByTestId("spark-card");
  const halCard = hal.page.getByTestId("spark-card");
  await expect(gia.page.getByTestId("spark-button")).toBeEnabled();
  await gia.page.getByTestId("spark-button").click();
  await expect(giaCard).toBeVisible({ timeout: 1_000 });
  await expect(halCard).toBeVisible({ timeout: 1_000 });

  const promptId = await giaCard.getAttribute("data-prompt-id");
  expect(promptId).toMatch(/^[a-z]+-\d{2}$/);
  await expect(halCard).toHaveAttribute("data-prompt-id", promptId!);
  await expect(giaCard).toHaveAttribute("data-from", "you");
  await expect(halCard).toHaveAttribute("data-from", "partner");
  // The same prompt in each viewer's language (both English here).
  const text = (await gia.page.getByTestId("spark-text").textContent())?.trim();
  expect(text).toBeTruthy();
  await expect(hal.page.getByTestId("spark-text")).toHaveText(text!);

  // The room cooldown runs on both sides.
  await expect(gia.page.getByTestId("spark-button")).toHaveAttribute("data-cooldown", "1");
  await expect(hal.page.getByTestId("spark-button")).toHaveAttribute("data-cooldown", "1");
  await expect(hal.page.getByTestId("spark-another")).toBeDisabled();

  await phoneShot(hal.page, "Pixel 7", "spark-card");
  await phoneShot(hal.page, "iPhone 14", "spark-card");

  await hal.page.getByTestId("spark-dismiss").click();
  await expect(halCard).toBeHidden();
  await expect(giaCard).toBeVisible();
});

test("live captions: the sender's transcript shows over the receiver's remote video only", async ({
  openStranger,
  acceptTimeoutMs,
}) => {
  const ivy = await openStranger("Ivy");
  const jay = await openStranger("Jay");
  await fakeSpeech(ivy.context, [
    { text: "hello", final: false, afterMs: 300 },
    { text: "hello there", final: true, afterMs: 900 },
  ]);
  await fakeSpeech(jay.context, []);
  await startCall(ivy, jay, acceptTimeoutMs);

  // Off by default on both sides: nothing flows until both turn it on.
  await expect(ivy.page.getByTestId("captions-toggle")).toHaveAttribute("aria-pressed", "false");
  await turnCaptionsOn(jay.page);
  await turnCaptionsOn(ivy.page);

  const line = jay.page.getByTestId("caption-line");
  await expect(line).toHaveText("hello there");
  await expect(line).toHaveAttribute("data-final", "1");
  await expect(jay.page.getByTestId("captions-overlay")).toBeVisible();
  // The sender does not see their own words.
  await expect(ivy.page.getByTestId("captions-overlay")).toHaveCount(0);

  await phoneShot(jay.page, "Pixel 7", "captions-overlay");
  await phoneShot(jay.page, "iPhone 14", "captions-overlay");

  // The line fades after 4 s.
  await expect(jay.page.getByTestId("captions-overlay")).toHaveCount(0, { timeout: 6_000 });

  // The choice is remembered on the device.
  expect(await jay.page.evaluate(() => localStorage.getItem("chizzy.captions"))).toBe("1");
});
