import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "node_modules/**",
    "dist/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "blob-report/**",
    "fixtures/**",
    "artifacts/**",
  ]),
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["scripts/**/*.ts", "tests/**/*.{ts,tsx}", "*.{js,mjs,ts}"],
    languageOptions: { globals: globals.node },
  },
);
