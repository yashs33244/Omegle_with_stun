import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "dist-e2e", "coverage", "playwright-report", "test-results"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Vendored shadcn/ui components are kept as generated upstream; our own ui primitives are linted like the rest.
    files: ["src/components/ui/alert-dialog.tsx"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
      "react-refresh/only-export-components": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Config files and tests run in Node.
    files: ["*.config.{ts,js}", "src/test/**/*.ts", "e2e/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // Playwright fixtures take `({}, use)`: an empty pattern and a `use` that is not React's.
    files: ["e2e/**/*.ts"],
    rules: {
      "no-empty-pattern": "off",
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    // UI copy lives in src/locales; the admin console is English only.
    files: ["src/**/*.tsx"],
    ignores: ["src/**/*.test.tsx", "src/pages/admin/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "JSXText[value=/[A-Za-z]{2,}/]", message: "Hard-coded UI text: use t() from react-i18next." },
      ],
    },
  }
);
