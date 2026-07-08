import { rmSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { makeDataDir, makeFixtureDir, runExample } from "./helpers"

describe("example: archive-stale", () => {
  it("archives projects whose directory is gone", async () => {
    // One backend, shared across both runs, so archive-stale sees what bootstrap created.
    const dataDir = makeDataDir()
    const fixture = makeFixtureDir(["gone"]) // becomes project "gone" -> <fixture>/gone
    try {
      const bootstrap = await runExample("bootstrap-projects.ts", [fixture], dataDir)
      expect(bootstrap.code, bootstrap.stderr).toBe(0)
      rmSync(fixture, { recursive: true, force: true }) // its directory is now stale

      const r = await runExample("archive-stale.ts", [], dataDir)
      expect(r.code, r.stderr).toBe(0)
      expect(r.stdout).toMatch(/archive-stale: archived 1 of 1 active/)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 45_000)
})
