import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: [
      "apps/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.tsx",
      "packages/**/test/**/*.test.ts",
      "packages/**/test/**/*.test.tsx",
      "test/architecture/**/*.test.ts"
    ],
    setupFiles: ["apps/desktop/test/ui/setup.ts"],
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
    alias: {
      "@expand/contracts": new URL("./packages/contracts", import.meta.url).pathname,
      "@expand/client-core": new URL("./packages/client-core", import.meta.url).pathname,
      "@expand/tui": new URL("./apps/tui", import.meta.url).pathname,
      "@expand/desktop": new URL("./apps/desktop/src", import.meta.url).pathname,
      "@expand/server": new URL("./apps/server", import.meta.url).pathname,
      "@expand/electron-ipc": new URL("./packages/electron-ipc", import.meta.url).pathname,
      "@expand/ink-input": new URL("./packages/ink-input", import.meta.url).pathname,
      "@expand": new URL("./apps/cli", import.meta.url).pathname
    }
  }
})
