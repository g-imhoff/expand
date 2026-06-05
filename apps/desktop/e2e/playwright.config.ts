import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  workers: 1,
  retries: 0
})
