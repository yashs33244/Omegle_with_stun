import React, { useMemo } from "react";
import { watermarkCode } from "./watermarkCode";

/** Spread over the tile so cropping a recording does not remove every copy. */
const SPOTS: React.CSSProperties[] = [
  { top: "18%", left: "8%" },
  { top: "48%", left: "42%" },
  { top: "78%", left: "12%" },
  { top: "30%", right: "6%" },
];

/**
 * A faint per-call code over the partner's video. It deters recording but
 * cannot prevent it; /safety explains this.
 */
export const Watermark: React.FC<{ roomId: string }> = ({ roomId }) => {
  const code = useMemo(() => watermarkCode(roomId), [roomId]);
  return (
    <div
      aria-hidden="true"
      data-testid="watermark"
      data-code={code}
      className="pointer-events-none select-none absolute inset-0 overflow-hidden"
      style={{ zIndex: 4 }}
    >
      {SPOTS.map((spot, i) => (
        <span
          key={i}
          className="absolute -rotate-12 font-mono text-xs tracking-widest text-white/20 whitespace-nowrap"
          style={spot}
        >
          chizzy {code}
        </span>
      ))}
    </div>
  );
};
