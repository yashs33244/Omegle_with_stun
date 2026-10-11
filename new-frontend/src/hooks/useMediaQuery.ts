import { useEffect, useState } from "react";

/** Breakpoint at which the call screen switches from the phone layout to two columns (Tailwind `lg`). */
export const DESKTOP_QUERY = "(min-width: 1024px)";
export const LANDSCAPE_QUERY = "(orientation: landscape)";

/** Live result of a CSS media query; false where matchMedia does not exist (jsdom). */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatch(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return match;
}
