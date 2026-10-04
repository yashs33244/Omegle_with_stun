import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useNextShortcut } from "./useNextShortcut";

function Harness({ enabled, onNext, dialog = false }: { enabled: boolean; onNext: () => void; dialog?: boolean }) {
  useNextShortcut(enabled, onNext);
  return (
    <div>
      <input data-testid="chat" />
      <button data-testid="button">x</button>
      {dialog && <div role="dialog">settings</div>}
    </div>
  );
}

describe("useNextShortcut", () => {
  it("Esc and the right arrow mean Next", () => {
    const onNext = vi.fn();
    const { getByTestId } = render(<Harness enabled onNext={onNext} />);
    fireEvent.keyDown(getByTestId("button"), { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(onNext).toHaveBeenCalledTimes(2);
  });

  it("ignores keys while typing in chat, with modifiers, or when a dialog is open", () => {
    const onNext = vi.fn();
    const { getByTestId, rerender } = render(<Harness enabled onNext={onNext} />);
    fireEvent.keyDown(getByTestId("chat"), { key: "ArrowRight" });
    fireEvent.keyDown(getByTestId("chat"), { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "ArrowRight", ctrlKey: true });
    rerender(<Harness enabled onNext={onNext} dialog />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onNext).not.toHaveBeenCalled();
  });

  it("does nothing outside a call", () => {
    const onNext = vi.fn();
    render(<Harness enabled={false} onNext={onNext} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onNext).not.toHaveBeenCalled();
  });
});
