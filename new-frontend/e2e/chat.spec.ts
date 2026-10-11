import { expect, test } from "./fixtures";
import { cameraTracks, chat, expectRemoteVideoPlaying, openChat, remoteVideoBrightness, startCall } from "./helpers";

test("chat works both ways with server-acked delivery and a typing indicator", async ({
  openStranger,
  acceptTimeoutMs,
}) => {
  const cleo = await openStranger("Cleo");
  const dev = await openStranger("Dev");
  await startCall(cleo, dev, acceptTimeoutMs);

  await openChat(cleo.page);
  await openChat(dev.page);

  await chat(cleo, dev, "hi Dev, how are you?");
  await chat(dev, cleo, "great thanks <b>not bold</b>");
  await chat(cleo, dev, "nice");

  // Text is rendered as text, never as markup.
  await expect(cleo.page.locator('[data-testid="chat-message"] b')).toHaveCount(0);
  await expect(cleo.page.getByTestId("chat-message")).toHaveCount(3);
  await expect(dev.page.getByTestId("chat-message")).toHaveCount(3);
});

test("text-only mode turns the camera and mic off for the partner and keeps chat working", async ({
  openStranger,
  acceptTimeoutMs,
}) => {
  const eve = await openStranger("Eve");
  const finn = await openStranger("Finn");
  await startCall(eve, finn, acceptTimeoutMs);
  await expectRemoteVideoPlaying(finn.page);
  await expect.poll(() => remoteVideoBrightness(finn.page), { message: "Finn sees Eve's camera" }).toBeGreaterThan(20);

  await eve.page.getByTestId("text-only-toggle").click();
  await expect(eve.page.getByText("Text Chat Mode")).toBeVisible();
  await expect(eve.page.getByText("You're chatting with Finn")).toBeVisible();
  // Eve's camera and microphone tracks are disabled, so Finn stops seeing and hearing her.
  const liveTracks = async () =>
    (await cameraTracks(eve.page))
      .filter((t) => t.state === "live")
      .map((t) => `${t.kind}:${t.enabled ? "on" : "off"}`)
      .sort();
  await expect.poll(liveTracks).toEqual(["audio:off", "video:off"]);
  await expect.poll(() => remoteVideoBrightness(finn.page), { message: "Finn only sees black" }).toBeLessThan(2);

  // The chat panel is always open in text-only mode; Finn opens his.
  await expect(eve.page.getByTestId("chat-input")).toBeVisible();
  await openChat(finn.page);
  await chat(eve, finn, "typing only now");
  await chat(finn, eve, "fine by me");

  await eve.page.getByRole("button", { name: "Switch to Video" }).click();
  await expect.poll(liveTracks).toEqual(["audio:on", "video:on"]);
  await expect.poll(() => remoteVideoBrightness(finn.page), { message: "Finn sees Eve again" }).toBeGreaterThan(20);
  await expectRemoteVideoPlaying(eve.page);
});
