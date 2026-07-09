import { readFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { describe, expect, it } from "vitest"
import { makeDataDir, makeFixtureDir, runExample, spawnExample } from "./helpers"

describe("example: audit-log", () => {
  it("appends a JSONL line for each project change", async () => {
    const dataDir = makeDataDir()
    const outfile = join(dataDir, "audit.jsonl")
    // Start the long-running audit-log in the background against the shared data dir.
    const audit = spawnExample("audit-log.ts", [outfile], dataDir)
    await sleep(1500) // let it connect + start tailing
    // Cause a change on the same backend: bootstrap a project from a throwaway fixture.
    const scan = makeFixtureDir(["audited"])
    try {
      const boot = await runExample("bootstrap-projects.ts", [scan], dataDir) // creates project "audited"
      expect(boot.code, boot.stderr).toBe(0)
      await sleep(1000) // let the event flow to the audit log
    } finally {
      audit.kill()
      rmSync(scan, { recursive: true, force: true })
    }
    expect(existsSync(outfile)).toBe(true)
    const lines = readFileSync(outfile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(lines.some((e) => e.tag === "ProjectCreated")).toBe(true)
    rmSync(dataDir, { recursive: true, force: true })
  }, 45_000)
})
