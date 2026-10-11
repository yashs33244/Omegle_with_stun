/**
 * What the client fetches from new-frontend/public/spark/prompts.<lang>.json:
 * `{ "version": 1, "prompts": [{ id, topics, text }] }`, one file per UI
 * language, generated from the catalog by scripts/sync-spark-prompts.sh.
 */
import { SPARK_PROMPTS } from "./catalog";

export const PROMPT_LANGS = ["en", "hi"] as const;
export type PromptLang = (typeof PROMPT_LANGS)[number];

export interface PromptFile {
  version: 1;
  prompts: { id: string; topics: readonly string[]; text: string }[];
}

export const promptFileName = (lang: PromptLang) => `prompts.${lang}.json`;

/** The file's exact bytes (pretty JSON, trailing newline) so `--check` can compare. */
export function promptFile(lang: PromptLang): string {
  const file: PromptFile = {
    version: 1,
    prompts: SPARK_PROMPTS.map((p) => ({ id: p.id, topics: p.topics, text: p[lang] })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}
