import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GenderFilterGate } from "@/premium";

const gate: GenderFilterGate = {
  unlocked: true,
  expiresAt: null,
  coins: 0,
  costPerDay: 0,
  enabled: false,
  openUnlockSheet: vi.fn(),
};

vi.mock("@/premium", () => ({ useGenderFilterGate: () => gate }));

import { GenderFilterPicker } from "./GenderFilterPicker";

describe("GenderFilterPicker", () => {
  beforeEach(() => {
    gate.unlocked = true;
    gate.enabled = false;
    vi.mocked(gate.openUnlockSheet).mockClear();
  });

  it("saves a filter straight away while the feature is free", async () => {
    const onChange = vi.fn();
    render(<GenderFilterPicker id="g" value="all" onChange={onChange} />);
    expect(screen.queryByTestId("g-lock")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Who do you want to meet? Everyone" }));
    await userEvent.click(screen.getByRole("option", { name: "Female" }));
    expect(onChange).toHaveBeenCalledWith("female");
  });

  it("shows the lock and opens the unlock sheet instead of saving while locked", async () => {
    gate.enabled = true;
    gate.unlocked = false;
    const onChange = vi.fn();
    render(<GenderFilterPicker id="g" value="all" onChange={onChange} />);
    expect(screen.getByTestId("g-lock")).toHaveTextContent("Unlock");
    await userEvent.click(screen.getByRole("button", { name: "Who do you want to meet? Everyone" }));
    await userEvent.click(screen.getByRole("option", { name: "Male" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(gate.openUnlockSheet).toHaveBeenCalledTimes(1);
  });

  it("still allows Everyone while locked", async () => {
    gate.enabled = true;
    gate.unlocked = false;
    const onChange = vi.fn();
    render(<GenderFilterPicker id="g" value="female" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Who do you want to meet? Female" }));
    await userEvent.click(screen.getByRole("option", { name: "Everyone" }));
    expect(onChange).toHaveBeenCalledWith("all");
    expect(gate.openUnlockSheet).not.toHaveBeenCalled();
  });
});
