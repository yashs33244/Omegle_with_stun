import { useEffect, useState } from "react";

export interface KeyboardInset {
  /** Pixels the on-screen keyboard covers at the bottom of the layout viewport; 0 when closed. */
  inset: number;
  /** Height of the part of the page the user can see (the visual viewport). */
  visibleHeight: number;
}

/**
 * Mobile browsers do not shrink the layout viewport for the on-screen
 * keyboard; only `visualViewport` tells how much of the bottom it covers.
 * Fixed elements (the chat sheet) subtract this inset so their input stays
 * above the keyboard. Returns zeros where visualViewport does not exist.
 */
export function useKeyboardInset(enabled: boolean): KeyboardInset {
  const [state, setState] = useState<KeyboardInset>({ inset: 0, visibleHeight: 0 });

  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!enabled || !vv) {
      setState({ inset: 0, visibleHeight: 0 });
      return;
    }
    const update = () =>
      setState({
        inset: Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)),
        visibleHeight: Math.round(vv.height),
      });
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [enabled]);

  return state;
}
