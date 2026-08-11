import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect } from "vitest"

const sourceExtensions = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

const collectFiles = Effect.fn("EffectFinalRatchetTest.collectFiles")(
  function* (root: string, relative: string): Effect.fn.Return<ReadonlyArray<string>, unknown, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* fs.readDirectory(`${root}/${relative}`)
    const files: Array<string> = []
    for (const entry of entries) {
      const child = relative === "" ? entry : `${relative}/${entry}`
      const info = yield* fs.stat(`${root}/${child}`)
      if (info.type === "Directory") files.push(...yield* collectFiles(root, child))
      else if (info.type === "File") files.push(child)
    }
    return files
  }
)

describe("final Effect ratchet", () => {
  it.live("deletes the legacy ledger and every configuration reference", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const baselineName = ["effect-audit", "-baseline.json"].join("")
      const removedSymbols = [
        ["effect", "audit"].join(":"),
        ["canUpdate", "Baseline"].join(""),
        ["Audit", "Baseline", "Json"].join(""),
        ["compare", "Audit"].join(""),
        ["migration", " ledger"].join("")
      ]
      const roots = [
        "package.json",
        "tsconfig.json",
        "tsconfig.workspace.json",
        "eslint.effect.config.mjs",
        ".dependency-cruiser.cjs",
        "docs/architecture",
        "scripts",
        "test",
        "eslint-rules",
        ".github",
        ".githooks"
      ]
      const files = [] as Array<string>
      for (const entry of roots) {
        const absolute = path.join(root, entry)
        if (!(yield* fs.exists(absolute))) continue
        const info = yield* fs.stat(absolute)
        if (info.type === "File") files.push(entry)
        else files.push(...yield* collectFiles(root, entry))
      }
      const references = [] as Array<string>
      for (const file of files) {
        const source = yield* fs.readFileString(path.join(root, file))
        if ([baselineName, ...removedSymbols].some((term) => source.includes(term))) references.push(file)
      }

      expect(yield* fs.exists(path.join(root, baselineName))).toBe(false)
      expect(references).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("documents only permanent zero-drift Effect gates", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const policy = yield* fs.readFileString("docs/architecture/EFFECT_ONLY.md")
      expect(policy).toContain("npm run lint")
      expect(policy).toContain("npm run typecheck:all")
      expect(policy).toContain("Human review")
      expect(policy).toContain("warnings, and suggestions")
      expect(policy).not.toContain([["effect", "audit"].join(":"), ":update"].join(""))
      expect(policy).not.toContain(["migration", " ledger"].join(""))
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("keeps source coverage free of inline disables and broad Effect exemptions", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const files = (yield* collectFiles(root, ""))
        .filter((file) => sourceExtensions.test(file))
        .filter((file) => !/(?:^|\/)(?:node_modules|dist|out|build|coverage|test-results|playwright-report|\.worktrees)(?:\/|$)/.test(file))
      const inlineDisables = [] as Array<string>
      for (const file of files) {
        const source = yield* fs.readFileString(path.join(root, file))
        if (/^\s*(?:\/\/|\/\*)\s*(?:eslint-disable|@ts-(?:ignore|nocheck))/m.test(source)) inlineDisables.push(file)
      }
      const eslintConfig = yield* fs.readFileString(path.join(root, "eslint.effect.config.mjs"))

      expect(inlineDisables).toEqual([])
      expect(eslintConfig).not.toMatch(/local\/effect-boundary[^\n]*(?:off|0)/)
      expect(eslintConfig).not.toContain('ignores: ["**/*"]')
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("keeps the retired Effect audit implementation absent", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const retiredFiles = [
        "scripts/effect-audit.ts",
        "scripts/effect-audit.test.ts",
        "scripts/effect-audit-model.ts",
        "scripts/effect-audit-test-support.mjs",
        "scripts/effect-audit-test-support.d.mts"
      ]
      expect(yield* Effect.forEach(retiredFiles, (file) => fs.exists(path.join(root, file)))).toEqual(
        retiredFiles.map(() => false)
      )
    }).pipe(Effect.provide(NodeServices.layer)))
})
