import tseslint from "typescript-eslint"
import { effectHostBoundaries } from "./eslint-rules/effect-host-boundaries.mjs"
import local from "./eslint-rules/index.mjs"

const repositoryRoot = new URL("./", import.meta.url)
const sourceFiles = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]
const generated = [
  "**/node_modules/**",
  "**/dist/**",
  "**/out/**",
  "**/build/**",
  "**/coverage/**",
  "**/test-results/**",
  "**/playwright-report/**"
]
const rule = ["error", effectHostBoundaries]

export default tseslint.config(
  { ignores: [".claude/worktrees/**", ".worktrees/**", ...generated] },
  {
    files: sourceFiles,
    plugins: { local },
    rules: { "local/effect-boundary": rule }
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        project: "./tsconfig.effect-audit.json",
        tsconfigRootDir: repositoryRoot.pathname
      }
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
