import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Segmented } from "./Segmented";

const options = [
  { value: "a", label: "Alpha", testId: "seg-a" },
  { value: "b", label: "Beta", testId: "seg-b" },
] as const;

describe("Segmented", () => {
  it("renders radios with the selected one checked and focusable", () => {
    render(<Segmented aria-label="Pick" options={options} value="b" onChange={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: "Pick" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Beta" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveAttribute("tabindex", "-1");
  });

  it("changes on click and on arrow keys", async () => {
    const onChange = vi.fn();
    render(<Segmented aria-label="Pick" options={options} value="a" onChange={onChange} />);
    await userEvent.click(screen.getByTestId("seg-b"));
    expect(onChange).toHaveBeenLastCalledWith("b");
    screen.getByTestId("seg-a").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("b");
    expect(screen.getByTestId("seg-b")).toHaveFocus();
  });

  it("uses aria-pressed buttons in group mode", () => {
    render(<Segmented role="group" aria-label="Pick" options={options} value="a" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Beta" })).toHaveAttribute("aria-pressed", "false");
  });
});
