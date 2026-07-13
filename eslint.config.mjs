import tseslint from "typescript-eslint"
import local from "./eslint-rules/index.mjs"

export default tseslint.config(
  {
    ignores: [
      ".claude/worktrees/**",
      ".worktrees/**",
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
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}", "examples/**/*.{ts,tsx}"],
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
      "bench/**/*.{ts,tsx,mts,cts}",
      "eslint-rules/**/*.{ts,tsx,mts,cts}",
      "migrations/**/*.{ts,tsx,mts,cts}",
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
    files: ["**/*.{js,jsx,mjs,cjs}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        project: false,
        projectService: false
      }
    }
  }
)
