import type { Page } from "@playwright/test";
import { expect, type Stranger } from "./fixtures";
import type { MatchEndReason, Topic } from "../src/lib/protocol";

export type GenderLabel = "Male" | "Female" | "Other" | "Prefer not to say";

export interface OnboardOptions {
  gender?: GenderLabel;
  /** Exactly these topics end up selected (the form starts with "general"). */
  topics?: Topic[];
  photo?: "capture" | "skip";
  /** Match mode picked on the start screen. Preview (the accept card) unless a test asks for instant. */
  mode?: "instant" | "preview";
}

/** A date of birth well over 18, as [day, month, year]. */
export const ADULT_DOB = ["14", "2", "1995"] as const;

/** Fills the date of birth form (and the attestation and Terms boxes). */
export async function fillGateForm(page: Page, [day, month, year]: readonly [string, string, string]): Promise<void> {
  await page.getByTestId("dob-day").fill(day);
  await page.getByTestId("dob-month").fill(month);
  await page.getByTestId("dob-year").fill(year);
  await page.getByTestId("attest-18").check();
  await page.getByTestId("accept-tos").check();
}

/**
 * Passes the session gate if it is showing: date of birth, 18+ attestation,
 * Terms, Turnstile (the always-pass test widget). A returning device with a
 * valid session goes straight to the camera screen.
 */
export async function passGate(s: Stranger, dob: readonly [string, string, string] = ADULT_DOB): Promise<void> {
  const { page } = s;
  if (page.url() === "about:blank") await page.goto("/");
  const start = page.getByTestId("start-chat");
  const form = page.getByTestId("gate-form");
  await expect(form.or(start), "the gate or the camera screen shows").toBeVisible();
  if (await start.isVisible()) return;
  if (await page.getByTestId("dob-day").isVisible()) await fillGateForm(page, dob);
  const next = page.getByTestId("gate-continue");
  await expect(next, "Continue is enabled once the bot check passed").toBeEnabled();
  await next.click();
  await expect(start).toBeVisible();
}

/** Opens the app, passes the gate, fills the profile dialog and starts chatting. Ends waiting or matched. */
export async function onboard(s: Stranger, opts: OnboardOptions = {}): Promise<void> {
  const { page } = s;
  const { gender = "Prefer not to say", topics = ["general"], photo = "skip", mode = "preview" } = opts;

  await passGate(s);
  const modeButton = page.getByTestId(`mode-${mode}`);
  await modeButton.click();
  await expect(modeButton).toHaveAttribute("aria-checked", "true");
  const start = page.getByTestId("start-chat");
  await expect(start, "Start is enabled once the camera is ready").toBeEnabled();
  await start.click();

  if (photo === "capture") {
    const capture = page.getByTestId("capture-photo");
    await expect(capture, "the camera preview has a frame").toBeEnabled();
    await capture.click();
    await expect(page.getByRole("img", { name: "Your profile photo" })).toBeVisible();
  } else {
    await page.getByTestId("skip-photo").click();
  }

  await page.getByTestId("name-input").fill(s.name);

  await page.getByTestId("gender-select").click();
  await page.getByRole("option", { name: gender, exact: true }).click();
  await expect(page.getByTestId("gender-select")).toHaveText(gender);

  for (const id of ["general", ...topics.filter((t) => t !== "general")] as Topic[]) {
    const button = page.getByTestId(`topic-${id}`);
    const want = topics.includes(id) ? "true" : "false";
    if ((await button.getAttribute("aria-pressed")) !== want) await button.click();
    await expect(button).toHaveAttribute("aria-pressed", want);
  }

  await page.getByTestId("begin-chat").click();
  // First visit on this device: the safety card comes before anything connects.
  const coach = page.getByTestId("safety-coach-continue");
  const queued = page.getByTestId("status-waiting").or(page.getByTestId("match-prompt")).or(page.getByTestId("next-button"));
  await expect(coach.or(queued).first()).toBeVisible();
  if (await coach.isVisible()) await coach.click();
  // Queued; a partner who is already waiting may match straight away (instant mode may already be in the call).
  await expect(queued).toBeVisible();
}

/** The match prompt names the partner and shows a running countdown within the accept window. */
export async function expectMatchPrompt(page: Page, partnerName: string, acceptTimeoutMs: number): Promise<void> {
  const prompt = page.getByTestId("match-prompt");
  await expect(prompt).toBeVisible();
  await expect(prompt.getByText(partnerName, { exact: true }).first()).toBeVisible();
  const countdown = prompt.getByTestId("match-countdown");
  await expect(countdown).toHaveText(/^\d+s$/);
  const seconds = parseInt((await countdown.textContent()) ?? "", 10);
  expect(seconds).toBeGreaterThan(0);
  expect(seconds).toBeLessThanOrEqual(Math.ceil(acceptTimeoutMs / 1000));
}

/** Both strangers see each other's match prompt and accept; the call starts on both sides. */
export async function acceptMatch(a: Stranger, b: Stranger, acceptTimeoutMs: number): Promise<void> {
  await expectMatchPrompt(a.page, b.name, acceptTimeoutMs);
  await expectMatchPrompt(b.page, a.name, acceptTimeoutMs);
  await a.page.getByTestId("match-accept").click();
  await b.page.getByTestId("match-accept").click();
  await expect(a.page.getByTestId("next-button")).toBeVisible();
  await expect(b.page.getByTestId("next-button")).toBeVisible();
}

/** Onboards both strangers with a shared topic, matches them and starts the call. */
export async function startCall(a: Stranger, b: Stranger, acceptTimeoutMs: number): Promise<void> {
  await onboard(a);
  await onboard(b);
  await acceptMatch(a, b, acceptTimeoutMs);
}

/**
 * The partner's video really plays: it has decoded frames, its clock advances,
 * and it is a WebRTC stream, not one of this page's own camera streams.
 */
export async function expectRemoteVideoPlaying(page: Page): Promise<void> {
  const video = page.getByTestId("remote-video");
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), {
      message: "remote video has frames",
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  const start = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { message: "remote video time advances" })
    .toBeGreaterThan(start + 0.5);
  const state = await video.evaluate((v: HTMLVideoElement) => {
    const src = v.srcObject instanceof MediaStream ? v.srcObject : null;
    return {
      paused: v.paused,
      hasStream: src !== null,
      isOwnCamera: src !== null && window.__e2eStreams.some((s) => s.id === src.id),
      liveVideoTracks: src?.getVideoTracks().filter((t) => t.readyState === "live").length ?? 0,
    };
  });
  expect(state).toEqual({ paused: false, hasStream: true, isOwnCamera: false, liveVideoTracks: 1 });
}

/** Back on the waiting screen, optionally with the reason the last match ended. */
export async function expectWaiting(page: Page, reason?: MatchEndReason): Promise<void> {
  await expect(page.getByTestId("status-waiting")).toBeVisible();
  if (reason) await expect(page.getByTestId("end-reason")).toHaveAttribute("data-reason", reason);
}

/**
 * Neither stranger is matched again for a while. Longer than the server's
 * full match pass (5 s), so a lapsed pair block would have been picked up.
 */
export async function expectNoRematch(pages: Page[], ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const page of pages) {
      // Point-in-time checks: a retrying assertion could outwait a short-lived match prompt.
      expect(await page.getByTestId("match-prompt").count(), "not matched again").toBe(0);
      expect(await page.getByTestId("status-waiting").isVisible(), "still waiting").toBe(true);
    }
    await pages[0]!.waitForTimeout(500);
  }
}

/** Opens the chat panel (video mode). */
export async function openChat(page: Page): Promise<void> {
  const toggle = page.getByTestId("chat-toggle");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
}

/**
 * Types a message (the partner sees the typing indicator), sends it, waits
 * for the server ack and checks the partner received it.
 */
export async function chat(from: Stranger, to: Stranger, text: string): Promise<void> {
  const typing = to.page.getByTestId("partner-typing");
  await expect(typing).toBeHidden();
  await from.page.getByTestId("chat-input").fill(text);
  await expect(typing, `${to.name} sees ${from.name} typing`).toBeVisible();

  await from.page.getByTestId("chat-send").click();
  await expect(from.page.getByTestId("chat-input")).toHaveValue("");
  const mine = from.page.locator('[data-testid="chat-message"][data-from="me"]').filter({ hasText: text });
  await expect(mine, "the server acknowledged the message").toHaveAttribute("data-delivery", "sent");

  const theirs = to.page.locator('[data-testid="chat-message"][data-from="partner"]').filter({ hasText: text });
  await expect(theirs).toHaveCount(1);
  await expect(typing, "the typing indicator clears once the message arrives").toBeHidden();
}

/** States of the camera tracks this page ever opened, oldest stream first. */
export function cameraTracks(page: Page): Promise<{ streamId: string; kind: string; state: string; enabled: boolean }[]> {
  return page.evaluate(() =>
    window.__e2eStreams.flatMap((s) =>
      s.getTracks().map((t) => ({ streamId: s.id, kind: t.kind, state: t.readyState, enabled: t.enabled })),
    ),
  );
}

/** Average brightness (0 to 255) of the partner's current video frame; 0 means black. */
export function remoteVideoBrightness(page: Page): Promise<number> {
  return page.getByTestId("remote-video").evaluate((v: HTMLVideoElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas");
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i]! + data[i + 1]! + data[i + 2]!;
    return sum / ((data.length / 4) * 3);
  });
}
