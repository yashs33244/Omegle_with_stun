/**
 * Browser and device detection for the mobile paths. Pure functions over the
 * user agent so they are unit tested; callers pass navigator.userAgent.
 */

/** In-app browsers (WebViews inside social apps) where the camera often fails. Order matters: first match wins. */
const IN_APP_MARKERS: Array<{ app: string; pattern: RegExp }> = [
  { app: "Instagram", pattern: /\bInstagram\b/i },
  { app: "Facebook", pattern: /\bFBAN\/|\bFBAV\/|\bFB_IAB\b|\bFBIOS\b/ },
  { app: "WhatsApp", pattern: /\bWhatsApp\b/i },
  { app: "Snapchat", pattern: /\bSnapchat\b/i },
  { app: "LinkedIn", pattern: /\bLinkedInApp\b/i },
  { app: "WeChat", pattern: /\bMicroMessenger\//i },
  { app: "TikTok", pattern: /\b(musical_ly|BytedanceWebview|TikTok|trill)\b/i },
  { app: "LINE", pattern: /\bLine\/\d/ },
];

/** The social app whose built-in browser this is, or null for a normal browser. */
export function detectInAppBrowser(userAgent: string): string | null {
  for (const { app, pattern } of IN_APP_MARKERS) {
    if (pattern.test(userAgent)) return app;
  }
  return null;
}

export type MobilePlatform = "ios" | "android" | "other";

export function mobilePlatform(userAgent: string, maxTouchPoints = 0): MobilePlatform {
  if (/Android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  // iPadOS reports a desktop Mac user agent but has a touch screen.
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return "ios";
  return "other";
}

/** Phones and tablets: smaller capture size and the camera flip button. */
export function isMobileDevice(userAgent: string, maxTouchPoints = 0): boolean {
  return mobilePlatform(userAgent, maxTouchPoints) !== "other" || /\bMobile\b/i.test(userAgent);
}

/**
 * An Android intent link that opens the current page in Chrome. Many in-app
 * browsers hand intent:// links to the system; when they do not, the copy-link
 * button still works.
 */
export function chromeIntentUrl(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const scheme = url.protocol.slice(0, -1);
    return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=${scheme};package=com.android.chrome;end`;
  } catch {
    return null;
  }
}

function currentNavigator(): Navigator | null {
  return typeof navigator === "undefined" ? null : navigator;
}

/** isMobileDevice() for the running browser. */
export function runningOnMobile(): boolean {
  const nav = currentNavigator();
  if (!nav) return false;
  const uaData = (nav as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof uaData?.mobile === "boolean" && uaData.mobile) return true;
  return isMobileDevice(nav.userAgent, nav.maxTouchPoints ?? 0);
}
