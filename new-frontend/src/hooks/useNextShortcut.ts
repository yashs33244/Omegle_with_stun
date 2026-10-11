import { useEffect, useRef } from "react";

/** True when the key press belongs to a text field or an open dialog, not to the page. */
export function isTypingOrDialog(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return true;
  return !!document.querySelector("[role='dialog'], [role='alertdialog']");
}

/** Esc or the right arrow means Next, unless you are typing or a dialog is open. */
export function useNextShortcut(enabled: boolean, onNext: () => void): void {
  const onNextRef = useRef(onNext);
  onNextRef.current = onNext;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "ArrowRight") return;
      if (e.defaultPrevented || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
      if (isTypingOrDialog(e.target)) return;
      e.preventDefault();
      onNextRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
