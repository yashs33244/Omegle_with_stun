import { describe, expect, it } from "vitest";
import { lazyNamespaces, resources as bundled, type Lang } from "@/lib/i18n";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;
const placeholders = (text: string) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]).sort();

/** Bundled and lazily loaded namespaces together, per language. */
const resources: Record<Lang, Record<string, Tree>> = { en: { ...bundled.en }, hi: { ...bundled.hi } };
for (const [ns, loaders] of Object.entries(lazyNamespaces)) {
  for (const [lang, loader] of Object.entries(loaders)) {
    resources[lang as Lang][ns] = (await loader()).default as Tree;
  }
}

const hiNamespaces = Object.keys(resources.hi);

describe("locales", () => {
  it("the console is the only English-only namespace", () => {
    const enOnly = Object.keys(resources.en).filter((ns) => !(ns in resources.hi));
    expect(enOnly).toEqual(["admin"]);
  });

  describe.each(hiNamespaces)("%s", (ns) => {
    const en = flatten(resources.en[ns] as Tree);
    const hi = flatten(resources.hi[ns] as Tree);

    it("hi has exactly the en keys", () => {
      expect(Object.keys(hi).sort()).toEqual(Object.keys(en).sort());
    });

    it("no value is empty", () => {
      const empty = [...Object.entries(en), ...Object.entries(hi)].filter(([, v]) => v.trim() === "").map(([k]) => k);
      expect(empty).toEqual([]);
    });

    it("hi keeps every {{placeholder}} of en", () => {
      const mismatched = Object.keys(en).filter(
        (key) => key in hi && placeholders(en[key]).join() !== placeholders(hi[key]).join(),
      );
      expect(mismatched).toEqual([]);
    });
  });
});
