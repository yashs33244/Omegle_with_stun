/**
 * Prompt text by id, in the viewer's UI language. The files under
 * public/spark/ are generated from backend/src/spark/catalog.ts
 * (scripts/sync-spark-prompts.sh); every language has the same ids, so the
 * two sides of a call can read the same prompt in different languages.
 */
import type { Lang } from "@/lib/i18n";

export type PromptTexts = Readonly<Record<string, string>>;

interface PromptFile {
  version: number;
  prompts: { id: string; text: string }[];
}

const loads = new Map<Lang, Promise<PromptTexts>>();

export function promptsUrl(lang: Lang): string {
  return `${import.meta.env.BASE_URL}spark/prompts.${lang}.json`;
}

async function fetchTexts(lang: Lang): Promise<PromptTexts> {
  const res = await fetch(promptsUrl(lang));
  if (!res.ok) throw new Error(`prompts ${lang}: HTTP ${res.status}`);
  const file = (await res.json()) as PromptFile;
  const texts: Record<string, string> = {};
  for (const prompt of file.prompts) texts[prompt.id] = prompt.text;
  return texts;
}

/**
 * Resolves to the texts for `lang`, falling back to English, then to an empty
 * table (the card then shows a retry hint). Loaded once per language per page.
 */
export function loadPrompts(lang: Lang): Promise<PromptTexts> {
  let load = loads.get(lang);
  if (!load) {
    load = fetchTexts(lang).catch(async () => {
      if (lang !== "en") return loadPrompts("en");
      loads.delete(lang); // let a later call retry
      return {};
    });
    loads.set(lang, load);
  }
  return load;
}

/** Tests: forget cached loads. */
export function resetPromptCache(): void {
  loads.clear();
}
