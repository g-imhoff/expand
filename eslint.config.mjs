import tseslint from "typescript-eslint"
import local from "./eslint-rules/index.mjs"

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.tmp/**",
      "**/.cache/**",
      "**/.worktrees/**",
      "**/dist/**",
      "**/out/**",
      "**/build/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/*.snap",
    ]
  },
  {
    files: [".expskill/design/**/*.{ts,tsx,mts,cts}", "apps/**/*.{ts,tsx,mts,cts}", "packages/**/*.{ts,tsx,mts,cts}", "examples/**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { local },
    rules: {
      "local/module-order": "error",
      "local/no-export-star": "error"
    }
  },
  {
    files: [
      "scripts/**/*.{ts,tsx,mts,cts}",
      "test/**/*.{ts,tsx,mts,cts}",
      "*.{ts,tsx,mts,cts}"
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } }
    }
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs}"]
  }
)
