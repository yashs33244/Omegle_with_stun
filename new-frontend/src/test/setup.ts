import "@testing-library/jest-dom/vitest";
// Registers the bundled English resources so components render real copy in tests.
import "@/lib/i18n";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
