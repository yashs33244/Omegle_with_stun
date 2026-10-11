/**
 * Resolves once the page has finished loading and the main thread is idle, or
 * after `timeoutMs` past the load event at the latest. For work that should
 * never compete with the first paint: SDK loads, model downloads.
 */
export function pageIdle(timeoutMs: number): Promise<void> {
  // Executor form: Promise.withResolvers is missing on the older Android browsers this runs on.
  return new Promise((resolve) => {
    const idle = () => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: timeoutMs });
      else setTimeout(resolve, timeoutMs);
    };
    if (typeof document === "undefined" || document.readyState === "complete") idle();
    else window.addEventListener("load", idle, { once: true });
  });
}
