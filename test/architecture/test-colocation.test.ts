import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect } from "vitest"
import { configDefaults } from "vitest/config"
import vitestConfig, {
  normalTestProject,
  processHeavyTestInclude,
  processHeavyTestProject,
  testInclude
} from "../../vitest.config"

const walk = Effect.fn("TestColocation.walk")(function*(dir: string, root: string): Effect.fn.Return<ReadonlyArray<string>, unknown, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files: Array<string> = []
  for (const entry of yield* fs.readDirectory(dir)) {
    const full = path.join(dir, entry)
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "out" ||
      (entry === ".worktrees" && dir === root)
    ) continue
    const info = yield* fs.stat(full)
    if (info.type === "Directory") files.push(...yield* walk(full, root))
    else files.push(full)
  }
  return files
})

const isTestFile = (file: string): boolean => file.endsWith(".test.ts") || file.endsWith(".test.tsx")

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

  it.live("every test outside test/architecture lives under an app or package test/ folder or an approved direct script test location", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = path.resolve(".")
      const all = (yield* walk(root, root)).filter(isTestFile).map((file) => path.relative(root, file))
      const misplaced = all.filter((relative) => {
        const rel = relative.split(path.sep).join("/")
        if (rel.startsWith("test/architecture/") || rel.startsWith("test/support/")) return false
        const ok =
          /^apps\/[^/]+\/test\//.test(rel) ||
          /^packages\/[^/]+\/test\//.test(rel) ||
          /^examples\/[^/]+\/test\//.test(rel) ||
          /^scripts\/[^/]+\.test\.tsx?$/.test(rel)
        return !ok
      })
      expect(misplaced).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("the legacy root test buckets no longer exist", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = path.resolve(".")
      const all = (yield* walk(root, root))
        .map((file) => path.relative(root, file).split(path.sep).join("/"))
        .filter((relative) => isTestFile(relative) || relative.endsWith(".snap"))
      const legacy = all.filter((rel) =>
        /^test\/(application|integration|unit|cli|contracts|client|desktop|tui)\//.test(rel)
      )
      expect(legacy).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))
})
