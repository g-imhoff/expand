import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
    globals: false,
    // The I-1 architecture fitness test shells out to dependency-cruiser, which
    // runs a full TypeScript pre-compilation graph analysis (~6-7s and growing
    // with the codebase) — well over vitest's 5s default. Integration/e2e tests
    // also boot a real server (incl. the ~1s I-4 graceful-stop window) and a few
    // re-spawn/retry cycles. Give every test generous headroom so the suite is
    // reliable rather than racing arbitrary wall-clock limits.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Coverage: the suite runs under `bun --bun vitest` (the whole stack is
    // Bun-only — `bun:sqlite`, `@effect/platform-bun`). The plan's pinned
    // `@vitest/coverage-v8` provider relies on the V8 inspector coverage APIs
    // (`Profiler.takePreciseCoverage`), which Bun's runtime does NOT implement —
    // running `--coverage` with `provider: "v8"` under `bun --bun` throws
    // "Coverage APIs are not supported" and reports a false 0%. The
    // source-instrumentation `istanbul` provider works under Bun and yields a
    // real baseline across all 56 suites. `@vitest/coverage-v8` remains a devDep
    // per the plan; the provider here is the one that actually functions on this
    // stack. (Running the v8 provider needs plain Node, which can't load the
    // Bun-only suites — only ~35/56 import.)
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: ["apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
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
    // Longest-prefix first: @yodea/contracts must be matched before the broader
    // @yodea alias so contract imports resolve to packages/contracts.
    alias: {
      "@yodea/contracts": new URL("./packages/contracts", import.meta.url).pathname,
      "@yodea/client-core": new URL("./packages/client-core", import.meta.url).pathname,
      "@yodea/tui": new URL("./apps/tui", import.meta.url).pathname,
      "@yodea/desktop": new URL("./apps/desktop/src", import.meta.url).pathname,
      "@yodea": new URL("./apps/cli", import.meta.url).pathname
    }
  }
})
