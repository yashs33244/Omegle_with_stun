// ESLint flat config (ESLint 9).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "error",
    },
  },
  {
    // Plain Node ESM tests run against the built server (bun run test:node).
    files: ["test-node/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", fetch: "readonly" } },
  },
);
