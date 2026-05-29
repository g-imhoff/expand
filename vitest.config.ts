import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    // The I-1 architecture fitness test shells out to dependency-cruiser, which
    // runs a full TypeScript pre-compilation graph analysis (~6-7s and growing
    // with the codebase) — well over vitest's 5s default. Integration/e2e tests
    // also boot a real server (incl. the ~1s I-4 graceful-stop window) and a few
    // re-spawn/retry cycles. Give every test generous headroom so the suite is
    // reliable rather than racing arbitrary wall-clock limits.
    testTimeout: 30_000,
    hookTimeout: 30_000
  },
  resolve: {
    alias: { "@yodea": new URL("./backend", import.meta.url).pathname }
  }
})
