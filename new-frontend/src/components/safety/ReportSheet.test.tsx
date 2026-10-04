import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReportSheet } from "./ReportSheet";
import type { ReportTarget } from "./useCallSafety";
import type { ReportAck } from "@/lib/protocol";

const ROOM = "11111111-1111-4111-8111-111111111111";
const FRAME = "data:image/jpeg;base64,AAAA";

const target = (over: Partial<ReportTarget> = {}): ReportTarget => ({
  roomId: ROOM,
  context: "call",
  partnerName: "Zed",
  frame: FRAME,
  chat: [
    { from: "partner", text: "add me on snap", ts: 10 },
    { from: "me", text: "no", ts: 11 },
  ],
  ...over,
});

function renderSheet(t: ReportTarget, ack: ReportAck = { ok: true, reportId: "abcdef1234567890" }) {
  const onSubmit = vi.fn(async (): Promise<ReportAck> => ack);
  const onClose = vi.fn();
  render(<ReportSheet target={t} onSubmit={onSubmit} onClose={onClose} />);
  return { onSubmit, onClose, user: userEvent.setup() };
}

describe("ReportSheet", () => {
  it("lists the six plain reasons and needs one before sending", () => {
    renderSheet(target());
    const radios = screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).value);
    expect(radios).toEqual(["nudity", "underage", "harassment", "spam", "fake", "other"]);
    expect(screen.getByRole("radio", { name: /Minor/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Fake or pre-recorded video/ })).toBeInTheDocument();
    expect(screen.getByTestId("report-submit")).toBeDisabled();
  });

  it("says what is attached and sends the frame and chat with the pinned room", async () => {
    const { onSubmit, user } = renderSheet(target());
    const attachments = screen.getByTestId("report-attachments");
    expect(attachments).toHaveTextContent("A still image of their video");
    expect(attachments).toHaveTextContent("The last 2 chat messages");

    await user.click(screen.getByRole("radio", { name: /Spam or scam/ }));
    await user.type(screen.getByLabelText(/Anything else/), "  asked for money ");
    await user.click(screen.getByTestId("report-submit"));

    expect(onSubmit).toHaveBeenCalledWith(ROOM, "spam", "asked for money", {
      frame: FRAME,
      chat: target().chat,
    });
    const received = await screen.findByTestId("report-received");
    expect(received).toHaveTextContent("Report received. We review reports.");
    expect(screen.getByTestId("report-reference")).toHaveTextContent("abcdef12");
  });

  it("lets the user leave attachments out", async () => {
    const { onSubmit, user } = renderSheet(target());
    await user.click(screen.getByRole("radio", { name: /Nudity/ }));
    await user.click(screen.getByTestId("attach-frame"));
    await user.click(screen.getByTestId("attach-chat"));
    await user.click(screen.getByTestId("report-submit"));
    expect(onSubmit).toHaveBeenCalledWith(ROOM, "nudity", undefined, undefined);
  });

  it("tells the user when nothing is attached (match card)", () => {
    renderSheet(target({ context: "match", frame: null, chat: [] }));
    expect(screen.getByText("No image or chat is attached.")).toBeInTheDocument();
    expect(screen.getByText("Sending a report skips this match.")).toBeInTheDocument();
  });

  it("shows the server error honestly and keeps the form", async () => {
    const { user } = renderSheet(target({ context: "post-call" }), { ok: false, error: "not_in_room" });
    expect(screen.getByRole("dialog", { name: "Report the person from your last call" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Other/ }));
    await user.click(screen.getByTestId("report-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("can no longer be reported");
    expect(screen.getByTestId("report-submit")).toBeEnabled();
    expect(screen.queryByTestId("report-received")).not.toBeInTheDocument();
  });

  it("is a labelled modal that traps focus and closes on Escape", async () => {
    const { onClose, user } = renderSheet(target());
    const dialog = screen.getByRole("dialog", { name: "Report Zed" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    // Shift+Tab from the first control wraps to the last enabled one (Send is disabled without a reason).
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
