/** Pointer events that closed an open Select because they landed outside it. */
const dismissals = new WeakSet<Event>();

export function markSelectDismissal(event: Event): void {
  dismissals.add(event);
}

/**
 * True when this pointerdown closed an open Select dropdown. A dialog can then
 * treat it like Escape: close the dropdown only, not the dialog. Checked by
 * event identity, so it does not matter whether React has removed the list yet.
 */
export function closedASelect(event: Event): boolean {
  return dismissals.has(event);
}

/**
 * Radix Content `onEscapeKeyDown` handler: keeps a dialog or sheet open when
 * Escape is meant for an open dropdown inside it (the Select closes itself).
 */
export function keepOpenWhileDropdownOpen(e: KeyboardEvent): void {
  const target = e.target;
  if (target instanceof Element && target.closest('[aria-expanded="true"], [role="listbox"]')) {
    e.preventDefault();
  }
}

/**
 * Radix Content `onPointerDownOutside` handler: like Escape, a press outside
 * while a dropdown is open closes only the dropdown, not the dialog or sheet.
 */
export function keepOpenWhenSelectClosed(e: { detail: { originalEvent: Event }; preventDefault(): void }): void {
  if (closedASelect(e.detail.originalEvent)) e.preventDefault();
}
