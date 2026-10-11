import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MatchPrompt } from "./MatchPrompt";
import type { PublicProfile } from "@/lib/protocol";

const partner: PublicProfile = { name: "Bo", country: "IN", language: "en", topics: ["music"] };

function renderPrompt(expiresAt: number) {
  const props = {
    partner,
    myTopics: ["music", "gaming"],
    isFriend: false,
    expiresAt,
    accepted: false,
    partnerAccepted: false,
    onAccept: vi.fn(),
    onDecline: vi.fn(),
    onReport: vi.fn(),
  };
  render(<MatchPrompt {...props} />);
  return props;
}

describe("MatchPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets you answer while the countdown runs", () => {
    const props = renderPrompt(Date.now() + 30_000);
    expect(screen.getByText("30s")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("match-accept"));
    fireEvent.click(screen.getByTestId("match-decline"));
    expect(props.onAccept).toHaveBeenCalledTimes(1);
    expect(props.onDecline).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Time's up/)).not.toBeInTheDocument();
  });

  it("highlights the topics you share and keeps the report entry point", () => {
    const props = renderPrompt(Date.now() + 30_000);
    expect(screen.getByTestId("shared-topics")).toHaveTextContent("Music");
    expect(screen.getByTestId("match-prompt")).toHaveTextContent("Interested in: Music");
    fireEvent.click(screen.getByTestId("match-report-button"));
    expect(props.onReport).toHaveBeenCalledTimes(1);
  });

  it("disables Accept and Pass once the countdown reaches 0", () => {
    const props = renderPrompt(Date.now() + 2_000);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const accept = screen.getByTestId("match-accept");
    const decline = screen.getByTestId("match-decline");
    expect(accept).toBeDisabled();
    expect(decline).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Time's up. Finding someone new...");
    fireEvent.click(accept);
    fireEvent.click(decline);
    expect(props.onAccept).not.toHaveBeenCalled();
    expect(props.onDecline).not.toHaveBeenCalled();
  });
});
