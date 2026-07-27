import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { describe, expect } from "vitest"
import { GrepInventoryJson } from "../../scripts/effect-inventory-model"

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
  it.live("deletes the ledger and every executable or configuration reference", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const baselineName = ["effect-audit", "-baseline.json"].join("")
      const removedSymbols = [
        ["effect:audit", ":update"].join(""),
        ["canUpdate", "Baseline"].join(""),
        ["Audit", "Baseline", "Json"].join(""),
        ["compare", "Audit"].join(""),
        ["shrinkGrep", "Inventory"].join("")
      ]
      const roots = ["package.json", "scripts", "test", "eslint-rules", ".github", ".githooks"]
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

  it.live("keeps source coverage free of inline disables and broad Effect exemptions", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const files = (yield* collectFiles(root, ""))
        .filter((file) => sourceExtensions.test(file))
        .filter((file) => !/(?:^|\/)(?:node_modules|dist|out|build|coverage|test-results|playwright-report)(?:\/|$)/.test(file))
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

  it.live("keeps the remaining migration inventory at zero debt", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const inventory = yield* fs.readFileString(path.join(root, "effect-grep-inventory.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(GrepInventoryJson)))

      expect(inventory.filter((candidate) => candidate.classification === "migration-debt")).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("keeps one exact scoped NodeRuntime audit entry with Schema parsing", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const source = yield* fs.readFileString(path.join(root, "scripts/effect-audit.ts"))

      expect(source.match(/NodeRuntime\.runMain\(/g)).toHaveLength(1)
      expect(source.match(/yield\* validateExecutableInventory\(/g)).toHaveLength(1)
      expect(source).toContain("Schema.fromJsonString")
      expect(source).not.toMatch(/JSON\.parse\(/)
      expect(source).toContain("Effect.scoped")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("rejects every CLI argument before executing the audit", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const attempts = yield* Effect.forEach(["--update", "--help", "--version", "unexpected"], (argument) =>
        Effect.scoped(Effect.gen(function*() {
          const handle = yield* spawner.spawn(ChildProcess.make("tsx", ["scripts/effect-audit.ts", argument], { cwd: root }))
          const [exitCode, stdout, stderr] = yield* Effect.all([
            handle.exitCode,
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString)
          ], { concurrency: "unbounded" })
          return { exitCode, stdout, stderr }
        })))

      expect(attempts.every(({ exitCode }) => exitCode !== 0)).toBe(true)
      expect(attempts.every(({ stdout, stderr }) => `${stdout}${stderr}`.includes("EffectAuditError"))).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer)))
})
