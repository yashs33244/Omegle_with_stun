/**
 * Writes (or with --check, compares) the Spark prompt files the frontend
 * serves. Run through scripts/sync-spark-prompts.sh from the repo root.
 *
 * Usage: bun scripts/exportSparkPrompts.ts <outDir> [--check]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SPARK_PROMPTS } from "../src/spark/catalog";
import { PROMPT_LANGS, promptFile, promptFileName } from "../src/spark/promptFile";

const say = (line: string) => process.stdout.write(`${line}\n`);
const warn = (line: string) => process.stderr.write(`${line}\n`);

const [outDir, flag] = process.argv.slice(2);
if (!outDir) {
  warn("usage: bun scripts/exportSparkPrompts.ts <outDir> [--check]");
  process.exit(2);
}
const check = flag === "--check";
if (!check) mkdirSync(outDir, { recursive: true });

let stale = 0;
for (const lang of PROMPT_LANGS) {
  const path = join(outDir, promptFileName(lang));
  const want = promptFile(lang);
  if (!check) {
    writeFileSync(path, want);
    say(`wrote ${path} (${SPARK_PROMPTS.length} prompts)`);
    continue;
  }
  let have = "";
  try {
    have = readFileSync(path, "utf8");
  } catch {
    // A missing file is stale.
  }
  if (have !== want) {
    stale += 1;
    warn(`${path} is out of date`);
  }
}

if (stale > 0) {
  warn("Spark prompts are out of sync. Run scripts/sync-spark-prompts.sh and commit the result.");
  process.exit(1);
}
if (check) say("spark prompts in sync");
