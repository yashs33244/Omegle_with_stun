import { expect, test } from "./fixtures";
import { expectMatchPrompt, expectNoRematch, expectWaiting, onboard } from "./helpers";

test("an unanswered match re-queues the accepter and idles the other stranger", async ({ openStranger, acceptTimeoutMs }) => {
  // The server's accept window, plus its 750 ms grace and sweep interval, plus slack.
  test.setTimeout(60_000 + acceptTimeoutMs * 2);
  const quinn = await openStranger("Quinn");
  const rosa = await openStranger("Rosa");
  await onboard(quinn);
  await onboard(rosa);
  await expectMatchPrompt(quinn.page, "Rosa", acceptTimeoutMs);
  await expectMatchPrompt(rosa.page, "Quinn", acceptTimeoutMs);

  // Quinn accepts, Rosa never answers.
  await quinn.page.getByTestId("match-accept").click();
  await expect(quinn.page.getByText("Waiting for Rosa to accept...")).toBeVisible();

  const ended = { timeout: acceptTimeoutMs + 10_000 };
  await expect(quinn.page.getByTestId("end-reason")).toHaveAttribute("data-reason", "timeout", ended);
  await expectWaiting(quinn.page, "timeout");
  await expect(quinn.page.getByTestId("end-reason")).toHaveText(
    "The other user didn't accept in time. Looking for someone else...",
  );
  // Rosa never accepted: she is idle, not searching, until she asks to search again.
  await expect(rosa.page.getByTestId("status-idle")).toBeVisible(ended);
  await expect(rosa.page.getByText("You didn't accept in time")).toBeVisible();
  await expect(rosa.page.getByTestId("status-waiting")).toHaveCount(0);
  await rosa.page.getByRole("button", { name: "Search again" }).click();
  await expectWaiting(rosa.page);
  // The pair is blocked for a while after a timeout.
  await expectNoRematch([quinn.page, rosa.page]);
});
