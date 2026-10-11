// @vitest-environment node
/**
 * Keeps the dependency list honest (BUGS.md U-15): every runtime dependency
 * must be imported by the app or its build config, so unused packages do not
 * creep back in and slow down `npm ci`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

const configFiles = readdirSync(root)
  .filter((f) => /\.(ts|js)$/.test(f))
  .map((f) => join(root, f));

const code = [...sourceFiles(join(root, "src")), ...configFiles].map((f) => readFileSync(f, "utf8")).join("\n");

/** Static imports, side-effect imports and lazy `import("...")` calls (Sentry and PostHog load on demand). */
function isImported(name: string): boolean {
  const escaped = name.replace(/[/.]/g, "\\$&");
  const spec = `["']${escaped}(/[^"']*)?["']`;
  return new RegExp(`from ${spec}|import ${spec}|import\\(\\s*${spec}\\s*\\)`).test(code);
}

/**
 * A peer dependency that another runtime dependency declares (for example
 * nsfwjs needs `buffer`): the app must list it even though it never imports it.
 */
function isPeerOfDependency(name: string, dependencies: string[]): boolean {
  return dependencies.some((dep) => {
    if (dep === name) return false;
    const manifest = JSON.parse(readFileSync(join(root, "node_modules", dep, "package.json"), "utf8")) as {
      peerDependencies?: Record<string, string>;
    };
    return name in (manifest.peerDependencies ?? {});
  });
}

describe("dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const names = Object.keys(pkg.dependencies);

  it.each(names)("%s is imported somewhere (or is a peer of a dependency)", (name) => {
    expect(isImported(name) || isPeerOfDependency(name, names)).toBe(true);
  });

  it("every components/ui wrapper is used outside components/ui", () => {
    const uiDir = join(root, "src", "components", "ui");
    const outside = sourceFiles(join(root, "src"))
      .filter((f) => !f.startsWith(uiDir))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const unused = readdirSync(uiDir)
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .map((f) => f.replace(/\.tsx?$/, ""))
      .filter((name) => !outside.includes(`@/components/ui/${name}"`));
    expect(unused).toEqual([]);
  });
});
