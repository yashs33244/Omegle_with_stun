/**
 * UI language. Resources are bundled (no network), so `t()` works synchronously
 * from the first render. The chosen language is remembered in localStorage and
 * mirrored to `<html lang>` so screen readers and hyphenation follow it.
 */
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import enAdmin from "@/locales/en/admin.json";
import enCommon from "@/locales/en/common.json";
import enGate from "@/locales/en/gate.json";
import enLanding from "@/locales/en/landing.json";
import enLegal from "@/locales/en/legal.json";
import enRoom from "@/locales/en/room.json";
import enSafety from "@/locales/en/safety.json";
import enSpark from "@/locales/en/spark.json";
import hiCommon from "@/locales/hi/common.json";
import hiGate from "@/locales/hi/gate.json";
import hiLanding from "@/locales/hi/landing.json";
import hiLegal from "@/locales/hi/legal.json";
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

/** The moderation console is English only: `hi` falls back to `en` for `admin`. */
export const resources = {
  en: {
    common: enCommon,
    landing: enLanding,
    gate: enGate,
    room: enRoom,
    safety: enSafety,
    spark: enSpark,
    legal: enLegal,
    admin: enAdmin,
  },
  hi: {
    common: hiCommon,
    landing: hiLanding,
    gate: hiGate,
    room: hiRoom,
    safety: hiSafety,
    spark: hiSpark,
    legal: hiLegal,
  },
} as const;

export const NAMESPACES = Object.keys(resources.en) as (keyof typeof resources.en)[];

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
  await i18n.changeLanguage(code);
}

export default i18n;
