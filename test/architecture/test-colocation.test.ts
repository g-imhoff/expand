import { describe, expect, it } from "vitest"
import { configDefaults } from "vitest/config"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import vitestConfig, {
  normalTestProject,
  processHeavyTestInclude,
  processHeavyTestProject,
  testInclude
} from "../../vitest.config"

const repoRoot = new URL("../..", import.meta.url).pathname

const walk = (dir: string): ReadonlyArray<string> => {
  const entries = readdirSync(dir)
  return entries.flatMap((entry) => {
    const full = join(dir, entry)
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "out" ||
      (entry === ".worktrees" && dir === repoRoot)
    )
      return []
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const isTestFile = (p: string): boolean => p.endsWith(".test.ts") || p.endsWith(".test.tsx")

describe("test colocation", () => {
  it("collects every approved direct script test extension", () => {
    expect(testInclude).toEqual(
      expect.arrayContaining(["scripts/**/*.test.ts", "scripts/**/*.test.tsx"])
    )
  })

  it("runs process-heavy suites serially after the normal project", () => {
    expect(testInclude).toEqual(
      expect.arrayContaining(["scripts/**/*.test.ts", "scripts/**/*.test.tsx"])
    )
    expect(processHeavyTestInclude).toEqual([
      "apps/server/test/integration/state-root-lock.test.ts",
      "packages/client-ts/test/integration/spawn-lock.test.ts",
      "examples/client-ts/test/archive-stale.smoke.test.ts"
    ])
    expect(normalTestProject).toEqual({
      extends: true,
      test: {
        name: "normal",
        include: testInclude,
        exclude: [...configDefaults.exclude, ...processHeavyTestInclude],
        sequence: { groupOrder: 0 }
      }
    })
    expect(processHeavyTestProject).toEqual({
      extends: true,
      test: {
        name: "process-heavy",
        include: processHeavyTestInclude,
        fileParallelism: false,
        sequence: { groupOrder: 1 }
      }
    })
    expect(vitestConfig.test).toMatchObject({
      maxWorkers: "50%",
      projects: [normalTestProject, processHeavyTestProject]
    })
    expect(vitestConfig.test).not.toHaveProperty("include")
    expect(normalTestProject.test.name).not.toBe(processHeavyTestProject.test.name)
  })

  it("preserves Vitest default exclusions in the normal project", () => {
    expect(normalTestProject.test.exclude).toEqual([
      ...configDefaults.exclude,
      ...processHeavyTestInclude
    ])
  })

  it("every test outside test/architecture lives under an app or package test/ folder or an approved direct script test location", () => {
    const all = walk(repoRoot).filter(isTestFile).map((p) => p.slice(repoRoot.length))
    const misplaced = all.filter((rel) => {
      if (rel.startsWith("test/architecture/")) return false
      const ok =
        /^apps\/[^/]+\/test\//.test(rel) ||
        /^packages\/[^/]+\/test\//.test(rel) ||
        /^examples\/[^/]+\/test\//.test(rel) ||
        /^scripts\/[^/]+\.test\.tsx?$/.test(rel)
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
