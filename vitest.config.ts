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
      "@yodea/contracts": new URL("./packages/contracts", import.meta.url).pathname,
      "@yodea/client-core": new URL("./packages/client-core", import.meta.url).pathname,
      "@yodea/tui": new URL("./apps/tui", import.meta.url).pathname,
      "@yodea/desktop": new URL("./apps/desktop/src", import.meta.url).pathname,
      "@yodea/server": new URL("./apps/server", import.meta.url).pathname,
      "@yodea/electron-ipc": new URL("./packages/electron-ipc", import.meta.url).pathname,
      "@yodea": new URL("./apps/cli", import.meta.url).pathname
    }
  }
})
