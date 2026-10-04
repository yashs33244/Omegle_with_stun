import { describe, expect, it } from "vitest";
import { chromeIntentUrl, detectInAppBrowser, isMobileDevice, mobilePlatform } from "./mobile";

const UA = {
  instagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 339.0.3.12.91 (iPhone14,5; iOS 17_5; en_US; en; scale=3.00; 1170x2532; 618495198)",
  facebookAndroid:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.6422.165 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/467.0.0.48.79;]",
  facebookIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/467.0.0.36.112;FBBV/622337539;FBDV/iPhone14,5]",
  whatsapp: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 WhatsApp/2.24.10.74",
  snapchat:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/13.0.0.43 (like Safari/8618.1.15.10.15, panda)",
  linkedin:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.29.6876",
  line: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.9.0",
  wechat:
    "Mozilla/5.0 (Linux; Android 12; M2102J20SG) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0 Mobile Safari/537.36 XWEB/5197 MMWEBSDK/20230202 MicroMessenger/8.0.33.2320(0x28002151) NetType/WIFI",
  tiktok:
    "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0 Mobile Safari/537.36 trill_340302 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/34.3.2 ByteLocale/en BytedanceWebview/d8a21c6",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  safariIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeDesktop: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
};

describe("detectInAppBrowser", () => {
  it.each([
    ["instagram", "Instagram"],
    ["facebookAndroid", "Facebook"],
    ["facebookIos", "Facebook"],
    ["whatsapp", "WhatsApp"],
    ["snapchat", "Snapchat"],
    ["linkedin", "LinkedIn"],
    ["line", "LINE"],
    ["wechat", "WeChat"],
    ["tiktok", "TikTok"],
  ] as const)("detects %s", (key, app) => {
    expect(detectInAppBrowser(UA[key])).toBe(app);
  });

  it.each(["chromeAndroid", "safariIos", "chromeDesktop", "macSafari"] as const)("leaves %s alone", (key) => {
    expect(detectInAppBrowser(UA[key])).toBeNull();
  });

  it("does not mistake Linux or other words for LINE", () => {
    expect(detectInAppBrowser("Mozilla/5.0 (X11; Linux x86_64) Pipeline/2.0")).toBeNull();
  });
});

describe("platform", () => {
  it("knows phones from desktops, including iPadOS", () => {
    expect(mobilePlatform(UA.chromeAndroid)).toBe("android");
    expect(mobilePlatform(UA.safariIos)).toBe("ios");
    expect(mobilePlatform(UA.macSafari, 5)).toBe("ios");
    expect(mobilePlatform(UA.macSafari, 0)).toBe("other");
    expect(isMobileDevice(UA.chromeAndroid)).toBe(true);
    expect(isMobileDevice(UA.chromeDesktop)).toBe(false);
  });

  it("builds a Chrome intent link for the current page", () => {
    expect(chromeIntentUrl("https://chizzy.example/?ref=ig")).toBe(
      "intent://chizzy.example/?ref=ig#Intent;scheme=https;package=com.android.chrome;end",
    );
    expect(chromeIntentUrl("about:blank")).toBeNull();
  });
});
