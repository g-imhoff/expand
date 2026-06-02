import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  // Single worker: the app discovers/spawns and shares one backend.
  workers: 1,
  retries: 0
})
