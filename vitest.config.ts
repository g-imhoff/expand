import { configDefaults, defineConfig, type TestProjectInlineConfiguration } from "vitest/config"

export const testInclude = [
  "apps/**/test/**/*.test.ts",
  "apps/**/test/**/*.test.tsx",
  "apps/desktop/e2e/effect-test.test.ts",
  "packages/**/test/**/*.test.ts",
  "packages/**/test/**/*.test.tsx",
  "test/architecture/**/*.test.ts",
  "test/support/**/*.test.ts",
  "scripts/**/*.test.ts",
  "scripts/**/*.test.tsx",
  "test/eslint/**/*.test.mjs",
  "examples/**/*.test.ts"
]

export const processHeavyTestInclude = [
  "apps/server/test/integration/state-root-lock.test.ts",
  "packages/client-ts/test/integration/spawn-lock.test.ts",
  "examples/client-ts/test/archive-stale.smoke.test.ts"
]

export const normalTestProject = {
  extends: true,
  test: {
    name: "normal",
    include: testInclude,
    exclude: [...configDefaults.exclude, ...processHeavyTestInclude],
    sequence: { groupOrder: 0 }
  }
} satisfies TestProjectInlineConfiguration

export const processHeavyTestProject = {
  extends: true,
  test: {
    name: "process-heavy",
    include: processHeavyTestInclude,
    fileParallelism: false,
    sequence: { groupOrder: 1 }
  }
} satisfies TestProjectInlineConfiguration

export default defineConfig({
  test: {
    maxWorkers: "50%",
    projects: [normalTestProject, processHeavyTestProject],
    setupFiles: ["apps/desktop/test/ui/setup.ts"],
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    server: {
      deps: {
        // @expand/* workspace packages resolve to TypeScript source via their
        // package.json "exports". Inline them so Vite transforms that source
        // instead of externalizing it to the runtime loader (which cannot load
        // a .ts entry). Covers current and future @expand workspace packages.
        inline: [/@expand\//]
      }
    },
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: ["apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "apps/**/test/**",
        "packages/**/test/**",
        "test/**",
        "**/*.config.*",
        "apps/desktop/e2e/**",
        "**/dist/**",
        "**/out/**",
        "**/node_modules/**"
      ]
    }
  },
  resolve: {
    // Array form so the bare "@expand" fallback can be a RegExp. @expand/contracts
    // and @expand/client-ts are intentionally NOT aliased: they resolve through
    // node_modules to their package.json "exports" (source .ts), which vitest
    // transforms thanks to the `test.server.deps.inline` entry above. The negative
    // lookahead keeps the bare "@expand" -> apps/cli fallback from greedily
    // swallowing @expand/contracts/* or @expand/client-ts (root + subpaths).
    alias: [
      { find: "@expand/tui", replacement: new URL("./apps/tui", import.meta.url).pathname },
      { find: "@expand/desktop", replacement: new URL("./apps/desktop/src", import.meta.url).pathname },
      { find: "@expand/server", replacement: new URL("./apps/server", import.meta.url).pathname },
      { find: "@expand/electron-ipc", replacement: new URL("./packages/electron-ipc", import.meta.url).pathname },
      { find: "@expand/ink-input", replacement: new URL("./packages/ink-input", import.meta.url).pathname },
      { find: /^@expand\/(?!contracts\/|client-ts(?:\/|$))(.*)$/, replacement: new URL("./apps/cli", import.meta.url).pathname + "/$1" }
    ]
  }
})
