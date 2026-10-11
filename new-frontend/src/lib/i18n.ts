/**
 * UI language. Resources are bundled (no network), so `t()` works synchronously
 * from the first render. The chosen language is remembered in localStorage and
 * mirrored to `<html lang>` so screen readers and hyphenation follow it.
 *
 * The `legal` and `admin` namespaces are the exception: they are only read on
 * the legal pages and in the console, so they stay out of the main bundle and
 * are added with loadNamespace() by the lazy route that needs them (App.tsx).
 */
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import type enAdmin from "@/locales/en/admin.json";
import enCommon from "@/locales/en/common.json";
import enGate from "@/locales/en/gate.json";
import enLanding from "@/locales/en/landing.json";
import type enLegal from "@/locales/en/legal.json";
import enPremium from "@/locales/en/premium.json";
import enRoom from "@/locales/en/room.json";
import enSafety from "@/locales/en/safety.json";
import enSpark from "@/locales/en/spark.json";
import hiCommon from "@/locales/hi/common.json";
import hiGate from "@/locales/hi/gate.json";
import hiLanding from "@/locales/hi/landing.json";
import hiPremium from "@/locales/hi/premium.json";
import hiRoom from "@/locales/hi/room.json";
import hiSafety from "@/locales/hi/safety.json";
import hiSpark from "@/locales/hi/spark.json";

export const LANG_STORAGE_KEY = "chizzy.lang";

export const LANGUAGES = [
  { code: "en", label: "English", short: "EN" },
  { code: "hi", label: "हिन्दी", short: "हिन्दी" },
] as const;

export type Lang = (typeof LANGUAGES)[number]["code"];

export const isLang = (value: unknown): value is Lang => LANGUAGES.some((l) => l.code === value);

/** Bundled with the app: every screen on the start-to-call path reads these. */
export const resources = {
  en: {
    common: enCommon,
    landing: enLanding,
    gate: enGate,
    room: enRoom,
    safety: enSafety,
    spark: enSpark,
    premium: enPremium,
  },
  hi: {
    common: hiCommon,
    landing: hiLanding,
    gate: hiGate,
    room: hiRoom,
    safety: hiSafety,
    spark: hiSpark,
    premium: hiPremium,
  },
} as const;

type BundleLoader = () => Promise<{ default: Record<string, unknown> }>;

/**
 * Loaded on first use, in the current language plus the English fallback;
 * setLanguage() fetches the other language when it is chosen.
 * The moderation console is English only: `hi` falls back to `en` for `admin`.
 */
export const lazyNamespaces: Record<"legal" | "admin", Partial<Record<Lang, BundleLoader>>> = {
  legal: {
    en: () => import("@/locales/en/legal.json"),
    hi: () => import("@/locales/hi/legal.json"),
  },
  admin: {
    en: () => import("@/locales/en/admin.json"),
  },
};

export type LazyNamespace = keyof typeof lazyNamespaces;

/** Every namespace's English keys, for typed `t()` (src/i18next.d.ts). */
export type Resources = (typeof resources)["en"] & { legal: typeof enLegal; admin: typeof enAdmin };

export const NAMESPACES = [...Object.keys(resources.en), ...Object.keys(lazyNamespaces)] as (keyof Resources)[];

/** In-flight or finished bundle loads by `${lang}|${ns}`; a failed load is removed so a later navigation retries. */
const bundleLoads = new Map<string, Promise<void>>();
/** Lazy namespaces some screen asked for, so setLanguage() can fetch their other language. */
const requestedNamespaces = new Set<LazyNamespace>();

function loadBundle(lang: Lang, ns: LazyNamespace): Promise<void> {
  const loader = lazyNamespaces[ns][lang];
  if (!loader) return Promise.resolve();
  const key = `${lang}|${ns}`;
  let load = bundleLoads.get(key);
  if (!load) {
    load = loader().then(({ default: bundle }) => {
      i18n.addResourceBundle(lang, ns, bundle);
    });
    load.catch(() => bundleLoads.delete(key));
    bundleLoads.set(key, load);
  }
  return load;
}

/** Adds a lazy namespace for the current language (and English, the fallback). Resolves at once when already loaded. */
export function loadNamespace(ns: LazyNamespace): Promise<void> {
  requestedNamespaces.add(ns);
  return Promise.all([loadBundle("en", ns), loadBundle(currentLang(), ns)]).then(() => undefined);
}

/** "hi-IN" -> "hi"; anything unsupported -> "en". */
export function toLang(code: string | undefined | null): Lang {
  const base = (code ?? "").toLowerCase().split("-")[0];
  return isLang(base) ? base : "en";
}

export function currentLang(): Lang {
  return toLang(i18n.resolvedLanguage ?? i18n.language);
}

function applyDocumentLang(code: string) {
  if (typeof document !== "undefined") document.documentElement.lang = toLang(code);
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en",
    supportedLngs: LANGUAGES.map((l) => l.code),
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    ns: NAMESPACES,
    defaultNS: "common",
    detection: {
      order: ["querystring", "localStorage", "navigator"],
      lookupQuerystring: "lang",
      lookupLocalStorage: LANG_STORAGE_KEY,
      // Only an explicit choice is persisted (see setLanguage).
      caches: [],
    },
    interpolation: { escapeValue: false },
    returnNull: false,
  });

i18n.on("languageChanged", applyDocumentLang);
applyDocumentLang(i18n.resolvedLanguage ?? i18n.language);

/** Switches the UI language and remembers the choice. */
export async function setLanguage(code: Lang): Promise<void> {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, code);
  } catch {
    // Private mode or a full quota: the choice lasts for this page only.
  }
  await Promise.all([...requestedNamespaces].map((ns) => loadBundle(code, ns)));
  await i18n.changeLanguage(code);
}

export default i18n;
