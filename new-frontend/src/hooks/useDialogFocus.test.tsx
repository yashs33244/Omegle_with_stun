import { describe, expect, it } from "vitest";
import { useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useDialogFocus } from "./useDialogFocus";

function Harness() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <button type="button">outside</button>
      {open && (
        <div ref={ref} role="dialog" aria-modal="true">
          <button type="button">first</button>
          <button type="button" onClick={() => setOpen(false)}>
            close
          </button>
        </div>
      )}
    </>
  );
}

describe("useDialogFocus", () => {
  it("moves focus in, keeps Tab inside, and restores focus on close", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "open" });

    await user.click(opener);
    expect(screen.getByRole("button", { name: "first" })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "close" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "first" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "close" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "close" }));
    expect(opener).toHaveFocus();
  });
});
