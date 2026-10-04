import { expect, test } from "./fixtures";
import { expectMatchPrompt, expectNoRematch, expectWaiting, onboard } from "./helpers";

test("an unanswered match times out for both strangers", async ({ openStranger, acceptTimeoutMs }) => {
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
  await expect(rosa.page.getByTestId("end-reason")).toHaveAttribute("data-reason", "timeout", ended);
  await expectWaiting(quinn.page, "timeout");
  await expectWaiting(rosa.page, "timeout");
  await expect(rosa.page.getByTestId("end-reason")).toHaveText("The match timed out. Looking for someone else...");
  // The pair is blocked for a while after a timeout.
  await expectNoRematch([quinn.page, rosa.page]);
});
