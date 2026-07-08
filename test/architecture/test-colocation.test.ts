import { describe, expect, it } from "vitest"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const repoRoot = new URL("../..", import.meta.url).pathname

const walk = (dir: string): ReadonlyArray<string> => {
  const entries = readdirSync(dir)
  return entries.flatMap((entry) => {
    const full = join(dir, entry)
    if (entry === "node_modules" || entry === "dist" || entry === "out") return []
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const isTestFile = (p: string): boolean => p.endsWith(".test.ts") || p.endsWith(".test.tsx")

describe("test colocation", () => {
  it("every test outside test/architecture lives under an app or package test/ folder", () => {
    const all = walk(repoRoot).filter(isTestFile).map((p) => p.slice(repoRoot.length))
    const misplaced = all.filter((rel) => {
      if (rel.startsWith("test/architecture/")) return false
      const ok =
        /^apps\/[^/]+\/test\//.test(rel) ||
        /^packages\/[^/]+\/test\//.test(rel) ||
        /^examples\/[^/]+\/test\//.test(rel)
      return !ok
    })
    expect(misplaced).toEqual([])
  })

  it("the legacy root test buckets no longer exist", () => {
    const all = walk(repoRoot)
      .map((p) => p.slice(repoRoot.length))
      .filter((rel) => isTestFile(rel) || rel.endsWith(".snap"))
    const legacy = all.filter((rel) =>
      /^test\/(application|integration|unit|cli|contracts|client|desktop|tui)\//.test(rel)
    )
    expect(legacy).toEqual([])
  })
})
