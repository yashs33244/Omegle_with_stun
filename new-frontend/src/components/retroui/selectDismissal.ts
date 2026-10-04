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
