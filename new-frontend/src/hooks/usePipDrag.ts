import { useCallback, useRef, useState, type CSSProperties, type PointerEvent } from "react";

const MARGIN = 8;

/**
 * Drag handling for the local picture-in-picture on small screens. The tile
 * starts in the top-right corner and stays inside its positioned parent.
 */
export function usePipDrag(enabled: boolean) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number; id: number } | null>(null);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (!enabled || (e.target as Element).closest("button")) return;
      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();
      drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, id: e.pointerId };
      el.setPointerCapture?.(e.pointerId);
    },
    [enabled],
  );

  const onPointerMove = useCallback((e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const el = e.currentTarget;
    const parent = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    if (!parent) return;
    const maxX = parent.width - el.offsetWidth - MARGIN;
    const maxY = parent.height - el.offsetHeight - MARGIN;
    setPos({
      x: Math.min(Math.max(MARGIN, e.clientX - parent.left - d.dx), Math.max(MARGIN, maxX)),
      y: Math.min(Math.max(MARGIN, e.clientY - parent.top - d.dy), Math.max(MARGIN, maxY)),
    });
  }, []);

  const onPointerUp = useCallback((e: PointerEvent<HTMLElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  }, []);

  const style: CSSProperties | undefined = enabled
    ? {
        position: "absolute",
        zIndex: 30,
        touchAction: "none",
        ...(pos ? { left: pos.x, top: pos.y } : { right: MARGIN * 2, top: MARGIN * 2 }),
      }
    : undefined;

  return { style, handlers: enabled ? { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } : {} };
}
