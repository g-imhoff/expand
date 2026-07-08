import { rmSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { runExample, makeFixtureDir } from "./helpers"

describe("example: bootstrap-projects", () => {
  it("creates one project per valid subfolder and reports the count", async () => {
    const dir = makeFixtureDir(["alpha", "beta"])   // two valid project-name dirs
    try {
      const r = await runExample("bootstrap-projects.ts", [dir])
      expect(r.code, r.stderr).toBe(0)
      expect(r.stdout).toContain("bootstrap: created 2, skipped 0")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
