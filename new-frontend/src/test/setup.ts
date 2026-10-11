import "@testing-library/jest-dom/vitest";
// Registers the bundled resources so components render real copy in tests,
// plus every language of the namespaces the app only loads on the legal pages
// and in the console.
import i18n, { lazyNamespaces } from "@/lib/i18n";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

await Promise.all(
  Object.entries(lazyNamespaces).flatMap(([ns, loaders]) =>
    Object.entries(loaders).map(async ([lang, load]) => {
      i18n.addResourceBundle(lang, ns, (await load()).default);
    }),
  ),
);

afterEach(() => {
  cleanup();
});
