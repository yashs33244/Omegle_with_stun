/**
 * On-device translation through the browser's built-in Translator API
 * (Chrome 138+ on desktop and Android: `"Translator" in self`). Everything is
 * feature-detected; where the API or a language pair is missing,
 * getTranslator() resolves null and callers show the original text.
 *
 * Nothing leaves the device: the API runs local models that Chrome downloads
 * once per language pair.
 */
export interface Translator {
  translate(text: string): Promise<string>;
  destroy?(): void;
}

export type TranslatorAvailability = "unavailable" | "downloadable" | "downloading" | "available";

interface TranslatorOptions {
  sourceLanguage: string;
  targetLanguage: string;
}

export interface TranslatorApi {
  availability(options: TranslatorOptions): Promise<TranslatorAvailability>;
  create(options: TranslatorOptions): Promise<Translator>;
}

/** The API object, or null where the browser has none. */
export function translatorApi(): TranslatorApi | null {
  const g = globalThis as { Translator?: TranslatorApi };
  return typeof g.Translator === "object" || typeof g.Translator === "function" ? g.Translator : null;
}

/** "hi-IN" and "hi" are one language for our purposes. */
export function baseLanguage(code: string): string {
  return code.toLowerCase().split("-")[0] ?? code;
}

const translators = new Map<string, Promise<Translator | null>>();

/**
 * A translator from `source` to `target`, created once per pair and cached.
 * Null when the languages match, the API is missing, or the pair is
 * unavailable (or its download cannot start without a user gesture).
 */
export function getTranslator(source: string, target: string): Promise<Translator | null> {
  const sourceLanguage = baseLanguage(source);
  const targetLanguage = baseLanguage(target);
  if (sourceLanguage === targetLanguage) return Promise.resolve(null);
  const api = translatorApi();
  if (!api) return Promise.resolve(null);
  const key = `${sourceLanguage}>${targetLanguage}`;
  let pending = translators.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const availability = await api.availability({ sourceLanguage, targetLanguage });
        if (availability === "unavailable") return null;
        return await api.create({ sourceLanguage, targetLanguage });
      } catch {
        return null;
      }
    })();
    translators.set(key, pending);
    // A failed creation is not cached, so a later call (after a user gesture) can retry.
    void pending.then((translator) => {
      if (!translator) translators.delete(key);
    });
  }
  return pending;
}

/** Tests: drop cached translators. */
export function resetTranslators(): void {
  translators.clear();
}
