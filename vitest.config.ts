import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false
  },
  resolve: {
    alias: { "@yodea": new URL("./backend", import.meta.url).pathname }
  }
})
