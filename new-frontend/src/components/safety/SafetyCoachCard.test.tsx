import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SafetyCoachGate } from "./SafetyCoachCard";
import { SAFETY_COACH_KEY } from "./safetyText";
import { Watermark } from "./Watermark";
import { watermarkCode } from "./watermarkCode";
import { RedactedText } from "./RedactedText";
import { ChatPanel } from "@/components/room/ChatPanel";

afterEach(() => {
  localStorage.clear();
});

describe("SafetyCoachGate", () => {
  it("shows the safety card with helplines once, then the room", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <SafetyCoachGate onBack={vi.fn()}>
        <p>room</p>
      </SafetyCoachGate>,
    );
    const card = screen.getByRole("dialog", { name: "Before you start" });
    expect(card).toHaveTextContent("Anyone can record their screen.");
    expect(card).toHaveTextContent("Never undress or move to another app for a stranger.");
    expect(card).toHaveTextContent("If someone threatens you, do not pay; report it.");
    expect(screen.getByRole("link", { name: "1930" })).toHaveAttribute("href", "tel:1930");
    expect(screen.getByRole("link", { name: "1098" })).toHaveAttribute("href", "tel:1098");
    expect(screen.getByRole("link", { name: "988" })).toHaveAttribute("href", "tel:988");
    expect(screen.getByRole("link", { name: "More safety tips" })).toHaveAttribute("href", "/safety");
    expect(screen.queryByText("room")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I understand" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "I understand" }));
    expect(screen.getByText("room")).toBeInTheDocument();
    expect(localStorage.getItem(SAFETY_COACH_KEY)).toBe("1");
    unmount();

    render(
      <SafetyCoachGate onBack={vi.fn()}>
        <p>room</p>
      </SafetyCoachGate>,
    );
    expect(screen.getByText("room")).toBeInTheDocument();
  });

  it("Back leaves without marking the card as seen", async () => {
    const onBack = vi.fn();
    render(
      <SafetyCoachGate onBack={onBack}>
        <p>room</p>
      </SafetyCoachGate>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
    expect(localStorage.getItem(SAFETY_COACH_KEY)).toBeNull();
  });
});

describe("watermark", () => {
  it("derives a stable XXXX-XXXX code from the room id", () => {
    const a = watermarkCode("33333333-3333-4333-8333-333333333333");
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(watermarkCode("33333333-3333-4333-8333-333333333333")).toBe(a);
    expect(watermarkCode("33333333-3333-4333-8333-333333333334")).not.toBe(a);
  });

  it("renders the code faintly and hidden from screen readers", () => {
    render(<Watermark roomId="33333333-3333-4333-8333-333333333333" />);
    const mark = screen.getByTestId("watermark");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark.textContent).toContain(watermarkCode("33333333-3333-4333-8333-333333333333"));
  });
});

describe("redacted chat", () => {
  it("styles every [hidden for safety] marker", () => {
    render(<RedactedText text="add me [hidden for safety] or [hidden for safety]" />);
    expect(screen.getAllByTestId("redaction-mark")).toHaveLength(2);
  });

  it("ChatPanel marks redacted lines and shows the inline safety notice", () => {
    render(
      <ChatPanel
        messages={[
          { id: "p1", from: "partner", text: "my insta [hidden for safety]", ts: 1 },
          { id: "m1", from: "me", text: "call 9999999999", ts: 2, delivery: "sent" },
          { id: "p2", from: "partner", text: "ok", ts: 3 },
        ]}
        partnerTyping={false}
        textOnly={false}
        onClose={vi.fn()}
        onSend={vi.fn()}
        onTyping={vi.fn()}
        redactedIds={new Set(["p1", "m1"])}
        safetyNotice="Anyone can record their screen."
      />,
    );
    expect(screen.getAllByTestId("redaction-mark")).toHaveLength(1);
    const notes = screen.getAllByTestId("redaction-note").map((n) => n.textContent);
    expect(notes).toEqual([
      "Links, handles and phone numbers are hidden for safety early in a call.",
      "Links, handles or phone numbers were hidden from them for safety.",
    ]);
    expect(screen.getByTestId("chat-safety-notice")).toHaveTextContent("Anyone can record their screen.");
  });
});
