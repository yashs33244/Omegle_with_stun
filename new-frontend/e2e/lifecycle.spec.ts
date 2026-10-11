import { expect, test } from "./fixtures";
import {
  acceptMatch,
  cameraTracks,
  expectMatchPrompt,
  expectNoRematch,
  expectRemoteVideoPlaying,
  expectWaiting,
  onboard,
  startCall,
} from "./helpers";

test("Skip sends both strangers back to waiting and they are not rematched", async ({
  openStranger,
  acceptTimeoutMs,
}) => {
  const gus = await openStranger("Gus");
  const hana = await openStranger("Hana");
  await startCall(gus, hana, acceptTimeoutMs);
  await expectRemoteVideoPlaying(gus.page);

  await gus.page.getByTestId("skip-button").click();

  await expectWaiting(gus.page, "skipped");
  await expectWaiting(hana.page, "partner-skipped");
  await expect(gus.page.getByTestId("remote-video")).toHaveCount(0);
  await expect(hana.page.getByTestId("remote-video")).toHaveCount(0);
  // The skipped pair is blocked from each other.
  await expectNoRematch([gus.page, hana.page]);
});

test("after a Skip both strangers meet someone new and the new calls have video", async ({
  openStranger,
  acceptTimeoutMs,
}) => {
  const ana = await openStranger("Ana");
  const bo = await openStranger("Bo");
  await startCall(ana, bo, acceptTimeoutMs);
  await expectRemoteVideoPlaying(ana.page);
  await ana.page.getByTestId("skip-button").click();
  await expectWaiting(ana.page, "skipped");
  await expectWaiting(bo.page, "partner-skipped");

  // Cy is matched with whichever of them waited longest, Dee with the other.
  const cy = await openStranger("Cy");
  await onboard(cy);
  const prompts = () =>
    Promise.all([ana, bo].map((s) => s.page.getByTestId("match-prompt").count())).then(([a, b]) => a! + b!);
  await expect.poll(prompts, { message: "exactly one of Ana and Bo is matched with Cy" }).toBe(1);
  const first = (await ana.page.getByTestId("match-prompt").count()) === 1 ? ana : bo;
  const second = first === ana ? bo : ana;
  await acceptMatch(first, cy, acceptTimeoutMs);

  const dee = await openStranger("Dee");
  await onboard(dee);
  await acceptMatch(second, dee, acceptTimeoutMs);

  for (const s of [first, cy, second, dee]) await expectRemoteVideoPlaying(s.page);
});

test("Pass declines the match for both strangers", async ({ openStranger, acceptTimeoutMs }) => {
  const ivy = await openStranger("Ivy");
  const jon = await openStranger("Jon");
  await onboard(ivy);
  await onboard(jon);
  await expectMatchPrompt(ivy.page, "Jon", acceptTimeoutMs);
  await expectMatchPrompt(jon.page, "Ivy", acceptTimeoutMs);

  await jon.page.getByTestId("match-decline").click();

  await expectWaiting(jon.page, "declined");
  await expectWaiting(ivy.page, "partner-declined");
  await expectNoRematch([ivy.page, jon.page]);
});

test("closing one stranger tells the partner and sends them back to waiting", async ({
  openStranger,
  acceptTimeoutMs,
}) => {
  const mia = await openStranger("Mia");
  const ned = await openStranger("Ned");
  await startCall(mia, ned, acceptTimeoutMs);
  await expectRemoteVideoPlaying(mia.page);

  await ned.context.close();

  await expectWaiting(mia.page, "partner-left");
  await expect(mia.page.getByTestId("end-reason")).toHaveText("Your chat partner has disconnected");
  await expect(mia.page.getByTestId("remote-video")).toHaveCount(0);
});

test("Home ends the call, releases its camera and microphone, and Start works again", async ({
  openStranger,
  acceptTimeoutMs,
}) => {
  const ola = await openStranger("Ola");
  const pia = await openStranger("Pia");
  await startCall(ola, pia, acceptTimeoutMs);
  await expectRemoteVideoPlaying(ola.page);

  const callStreams = new Set((await cameraTracks(ola.page)).filter((t) => t.state === "live").map((t) => t.streamId));
  expect(callStreams.size).toBe(1);

  await ola.page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(ola.page.getByTestId("start-chat")).toBeVisible();

  const tracks = await cameraTracks(ola.page);
  const callTracks = tracks.filter((t) => callStreams.has(t.streamId));
  expect(callTracks.map((t) => t.kind).sort()).toEqual(["audio", "video"]);
  for (const t of callTracks) expect(t, `${t.kind} track of the call`).toMatchObject({ state: "ended" });

  await expectWaiting(pia.page, "partner-left");

  // Starting again opens a fresh camera and the next call has video both ways.
  await onboard(ola);
  await acceptMatch(ola, pia, acceptTimeoutMs);
  await expectRemoteVideoPlaying(ola.page);
  await expectRemoteVideoPlaying(pia.page);
  const live = (await cameraTracks(ola.page)).filter((t) => t.state === "live");
  expect(live.map((t) => t.kind).sort()).toEqual(["audio", "video"]);
  expect(live.some((t) => callStreams.has(t.streamId))).toBe(false);
});
