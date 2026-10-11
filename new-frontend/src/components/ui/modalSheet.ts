/**
 * Which modal BottomSheets are open, for UI that floats outside them.
 * BottomSheet counts itself in while `open && modal`; useModalSheetOpen()
 * is true while the count is above zero.
 */
import { useSyncExternalStore } from "react";

let openModalSheets = 0;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function countModalSheet(delta: 1 | -1): void {
  openModalSheets += delta;
  listeners.forEach((listener) => listener());
}

/** True while any modal BottomSheet is open. */
export function useModalSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, () => openModalSheets > 0, () => false);
}
