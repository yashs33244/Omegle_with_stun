import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BottomSheet } from "./BottomSheet";

function renderSheet(props: Partial<React.ComponentProps<typeof BottomSheet>> = {}) {
  const onOpenChange = vi.fn();
  render(
    <BottomSheet open title="Sheet title" description="What it does" onOpenChange={onOpenChange} footer={<button>Done</button>} {...props}>
      <input aria-label="Field" />
    </BottomSheet>,
  );
  return onOpenChange;
}

describe("BottomSheet", () => {
  it("is a labelled modal dialog with its description", () => {
    renderSheet({ "data-testid": "sheet" });
    const dialog = screen.getByRole("dialog", { name: "Sheet title" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("What it does");
    expect(screen.getByTestId("sheet")).toBe(dialog);
    // The backdrop is the previous sibling, so pressing it is "outside".
    expect(dialog.previousElementSibling).toBe(screen.getByTestId("sheet-backdrop"));
  });

  it("closes on Escape and on the close button", async () => {
    const onOpenChange = renderSheet({ closeLabel: "Close it" });
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await userEvent.click(screen.getByRole("button", { name: "Close it" }));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it("keeps focus inside while open", async () => {
    renderSheet();
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    const inside = [screen.getByLabelText("Field"), screen.getByRole("button", { name: "Done" }), screen.getByRole("button", { name: "Close" })];
    for (let i = 0; i < 4; i++) {
      await userEvent.tab();
      expect(inside).toContain(document.activeElement);
    }
  });

  it("renders no backdrop when non-modal", () => {
    renderSheet({ modal: false });
    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toHaveAttribute("aria-modal", "true");
    expect(screen.queryByTestId("sheet-backdrop")).not.toBeInTheDocument();
  });
});
