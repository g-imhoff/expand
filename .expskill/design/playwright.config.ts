import { resolve } from "node:path"
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "proof.spec.ts",
  outputDir: resolve(import.meta.dirname, "../../.tmp/setup-design-proof/results"),
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(import.meta.dirname, "../../.tmp/setup-design-proof/results.json") }]
  ],
  workers: 1,
  retries: 0,
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "./node_modules/.bin/vite --config .expskill/design/vite.config.ts --host 127.0.0.1 --port 4173 --strictPort",
    cwd: resolve(import.meta.dirname, "../.."),
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false
  }
})
