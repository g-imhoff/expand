import { readFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeDataDir, makeFixtureDir, runExample, spawnExample } from "./helpers"

/** Parse the audit JSONL, tolerating an absent/partial file mid-write. */
const auditLines = (outfile: string): ReadonlyArray<{ readonly tag?: string }> =>
  existsSync(outfile)
    ? readFileSync(outfile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : []

/** Poll `predicate` until it returns true or `timeoutMs` elapses. */
const pollUntil = async (predicate: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

describe("example: audit-log", () => {
  it("appends a JSONL line for each project change", async () => {
    const dataDir = makeDataDir()
    const outfile = join(dataDir, "audit.jsonl")
    const scan = makeFixtureDir(["audited"])
    // Start the long-running audit-log in the background against the shared data dir.
    const audit = spawnExample("audit-log.ts", [outfile], dataDir)
    try {
      await audit.waitForLine("audit-log: writing to", 30_000)
      // Cause a change on the same backend: bootstrap a project from a throwaway fixture.
      const boot = await runExample("bootstrap-projects.ts", [scan], dataDir) // creates project "audited"
      expect(boot.code, boot.stderr).toBe(0)
      // Poll the outfile for the event instead of a flat sleep.
      const seen = await pollUntil(() => auditLines(outfile).some((e) => e.tag === "ProjectCreated"), 5_000)
      expect(seen, "expected a ProjectCreated line in the audit log").toBe(true)
    } finally {
      await audit.kill()
      rmSync(scan, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 45_000)
})
