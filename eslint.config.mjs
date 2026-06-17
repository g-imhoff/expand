import tseslint from "typescript-eslint"
import local from "./eslint-rules/index.mjs"

// Lean ESLint setup: the TypeScript parser plus Yodea's own layout rules. We
// intentionally do NOT pull in the full typescript-eslint recommended set —
// the goal here is to enforce project conventions, not to retrofit a style
// guide across the existing codebase.
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/*.snap",
      "eslint-rules/**",
      "eslint.config.mjs"
    ]
  },
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { local },
    rules: {
      "local/exports-on-top": "error",
      "local/no-export-star": "error"
    }
  }
)
