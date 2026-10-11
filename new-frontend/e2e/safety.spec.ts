import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  chat,
  expectMatchPrompt,
  expectRemoteVideoPlaying,
  expectWaiting,
  onboard,
  openChat,
  passGate,
  startCall,
} from "./helpers";
import { LIMITS, type ReportPayload } from "../src/lib/protocol";

/** Socket.IO event packets this page sent and received, as [event, payload]. */
function recordSocketEvents(page: Page) {
  const sent: [string, unknown][] = [];
  const received: [string, unknown][] = [];
  const parse = (data: string | Buffer): [string, unknown] | null => {
    const text = typeof data === "string" ? data : data.toString();
    const m = /^42\d*(\[.*\])$/s.exec(text);
    if (!m) return null;
    const [event, payload] = JSON.parse(m[1]!) as [string, unknown];
    return [event, payload];
  };
  page.on("websocket", (ws) => {
    ws.on("framesent", (f) => {
      const e = parse(f.payload);
      if (e) sent.push(e);
    });
    ws.on("framereceived", (f) => {
      const e = parse(f.payload);
      if (e) received.push(e);
    });
  });
  return {
    sentReports: () => sent.filter(([e]) => e === "report:submit").map(([, p]) => p as ReportPayload),
    roomIds: () =>
      received.filter(([e]) => e === "match:found").map(([, p]) => (p as { roomId: string }).roomId),
  };
}

test("the safety card shows once before the first match", async ({ openStranger }) => {
  const ada = await openStranger("Ada");
  const { page } = ada;
  await passGate(ada);
  await page.getByTestId("start-chat").click();
  await page.getByTestId("skip-photo").click();
  await page.getByTestId("name-input").fill(ada.name);
  await page.getByTestId("begin-chat").click();

  const card = page.getByRole("dialog", { name: "Before you start" });
  await expect(card).toContainText("Anyone can record their screen.");
  await expect(card).toContainText("If someone threatens you, do not pay; report it.");
  await expect(card.getByRole("link", { name: "1930" })).toHaveAttribute("href", "tel:1930");
  await expect(page.getByTestId("status-waiting")).toHaveCount(0);
  await card.getByRole("button", { name: "I understand" }).click();
  await expect(page.getByTestId("status-waiting")).toBeVisible();

  // Back home and in again: no card the second time.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByTestId("start-chat").click();
  await page.getByTestId("skip-photo").click();
  await page.getByTestId("begin-chat").click();
  await expect(page.getByTestId("status-waiting")).toBeVisible();
  await expect(card).toHaveCount(0);
});

test("report from the video overlay attaches the partner frame and chat and shows the server ack", async ({
  openStranger,
  acceptTimeoutMs,
}) => {
  const ivy = await openStranger("Ivy");
  const jon = await openStranger("Jon");
  const events = recordSocketEvents(ivy.page);
  await startCall(ivy, jon, acceptTimeoutMs);
  await expectRemoteVideoPlaying(ivy.page);
  await expect(ivy.page.getByTestId("watermark")).toHaveAttribute("data-code", /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  await openChat(ivy.page);
  await openChat(jon.page);
  await chat(jon, ivy, "come on snap");

  await ivy.page.getByTestId("report-button").click();
  await expect(ivy.page.getByRole("dialog", { name: "Report Jon" })).toBeVisible();
  // The title changes to "Report sent" once the server acks.
  const sheet = ivy.page.getByTestId("report-sheet");
  const attachments = sheet.getByTestId("report-attachments");
  await expect(attachments).toContainText("A still image of their video");
  await expect(attachments).toContainText("The last chat message");
  await sheet.getByRole("radio", { name: /Nudity/ }).check();
  await sheet.getByTestId("report-submit").click();

  await expect(sheet.getByTestId("report-received")).toHaveText(/Report received\. We review reports\./);
  await expect(sheet.getByTestId("report-reference")).toHaveText(/^[0-9a-f-]{8}$/);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toBeHidden();

  // The report ended the call; Jon only learns that Ivy moved on.
  await expectWaiting(ivy.page, "reported");
  await expectWaiting(jon.page, "partner-skipped");
  await expect(ivy.page.getByTestId("post-call-report"), "no second offer after a report").toHaveCount(0);

  const [report] = events.sentReports();
  expect(report?.roomId).toBe(events.roomIds()[0]);
  expect(report?.reason).toBe("nudity");
  expect(report?.evidence?.frame).toMatch(/^data:image\/jpeg;base64,/);
  expect(report?.evidence?.frame?.length).toBeLessThanOrEqual(LIMITS.evidenceFrameMaxChars);
  expect(report?.evidence?.chat?.map(({ from, text }) => ({ from, text }))).toEqual([
    { from: "partner", text: "come on snap" },
  ]);
});

test("after a call ends the post-call screen reports the right person with evidence from that call", async ({
  openStranger,
  acceptTimeoutMs,
}) => {
  const kai = await openStranger("Kai");
  const lea = await openStranger("Lea");
  const events = recordSocketEvents(kai.page);
  await startCall(kai, lea, acceptTimeoutMs);
  await expectRemoteVideoPlaying(kai.page);
  await openChat(kai.page);
  await openChat(lea.page);
  await chat(lea, kai, "you will regret this");

  await lea.page.getByTestId("skip-button").click();
  await expectWaiting(kai.page, "partner-skipped");

  const card = kai.page.getByTestId("post-call-report");
  await expect(card).toContainText("Was something wrong with Lea?");
  await card.getByRole("button", { name: "Report this person" }).click();

  await expect(kai.page.getByRole("dialog", { name: "Report the person from your last call" })).toBeVisible();
  // The title changes to "Report sent" once the server acks.
  const sheet = kai.page.getByTestId("report-sheet");
  await expect(sheet.getByTestId("report-attachments")).toContainText("taken when the call ended");
  await expect(sheet.getByTestId("report-attachments")).toContainText("The last chat message");
  await sheet.getByRole("radio", { name: /Harassment or hate/ }).check();
  await sheet.getByTestId("report-submit").click();

  // The server decides whether the 60 s window is open; the sheet shows its answer as is.
  await expect(
    sheet.getByTestId("report-received").or(sheet.getByRole("alert").filter({ hasText: "can no longer be reported" })),
  ).toBeVisible();

  const [report] = events.sentReports();
  expect(report?.roomId, "pinned to the call that ended").toBe(events.roomIds()[0]);
  expect(report?.reason).toBe("harassment");
  expect(report?.evidence?.frame).toMatch(/^data:image\/jpeg;base64,/);
  expect(report?.evidence?.chat?.map(({ from, text }) => ({ from, text }))).toEqual([
    { from: "partner", text: "you will regret this" },
  ]);
});

test("the match card can be reported before accepting, with nothing attached", async ({
  openStranger,
  acceptTimeoutMs,
}) => {
  const max = await openStranger("Max");
  const noa = await openStranger("Noa");
  await onboard(max);
  await onboard(noa);
  await expectMatchPrompt(max.page, "Noa", acceptTimeoutMs);

  await max.page.getByTestId("match-report-button").click();
  await expect(max.page.getByRole("dialog", { name: "Report Noa" })).toBeVisible();
  // The title changes to "Report sent" once the server acks.
  const sheet = max.page.getByTestId("report-sheet");
  await expect(sheet.getByTestId("report-attachments")).toContainText("No image or chat is attached.");
  await sheet.getByRole("radio", { name: /Spam or scam/ }).check();
  await sheet.getByTestId("report-submit").click();
  await expect(sheet.getByTestId("report-received")).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expectWaiting(max.page, "reported");
});
