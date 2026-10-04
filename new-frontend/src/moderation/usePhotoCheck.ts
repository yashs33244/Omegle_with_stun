import { useEffect, useState } from "react";
import { VERDICT_DEADLINE_MS, isUnsafe } from "./blurGate";
import { grabFrame, loadImage } from "./frames";
import { classifyImage } from "./useRemoteBlur";

/**
 * checking: blurred while the classifier runs; safe: shown; unsafe: stays hidden;
 * unavailable: the model could not decide in time, the viewer may tap to show.
 */
export type PhotoVerdict = "checking" | "safe" | "unsafe" | "unavailable";

/** A partner's profile photo stays blurred until the on-device classifier passes it. */
export function usePhotoCheck(photo: string | undefined): PhotoVerdict {
  const [verdict, setVerdict] = useState<PhotoVerdict>("checking");

  useEffect(() => {
    setVerdict("checking");
    if (!photo) return;
    let cancelled = false;
    const deadline = setTimeout(() => {
      if (!cancelled) setVerdict((v) => (v === "checking" ? "unavailable" : v));
    }, VERDICT_DEADLINE_MS);
    (async () => {
      try {
        const img = await loadImage(photo);
        const frame = grabFrame(img, 224, "square");
        if (!frame) throw new Error("photo could not be read");
        const scores = await classifyImage(frame);
        if (!cancelled) setVerdict(isUnsafe(scores) ? "unsafe" : "safe");
      } catch {
        if (!cancelled) setVerdict((v) => (v === "checking" ? "unavailable" : v));
      } finally {
        clearTimeout(deadline);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(deadline);
    };
  }, [photo]);

  return verdict;
}
