import tseslint from "typescript-eslint"
import local from "./eslint-rules/index.mjs"
import { effectHostBoundaries } from "./eslint-rules/effect-host-boundaries.mjs"

const sourceFiles = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]
const generated = [
  "**/node_modules/**",
  "**/dist/**",
  "**/out/**",
  "**/build/**",
  "**/coverage/**",
  "**/test-results/**",
  "**/playwright-report/**",
  "**/.worktrees/**"
]

export default tseslint.config(
  { ignores: generated },
  { files: sourceFiles, plugins: { local } },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.workspace.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: { "local/effect-boundary": ["error", effectHostBoundaries] }
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    rules: { "local/effect-boundary": ["error", effectHostBoundaries] }
  }
)
