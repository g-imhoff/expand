import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { describe, expect } from "vitest"
import { runCommand } from "../support/effect-process"

const EFFECT_PACKAGES = [
  "effect",
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "@effect/sql-sqlite-node"
] as const

const DIRECT_PINS = [
  "effect",
  "@effect/platform-node",
  "@effect/sql-sqlite-node"
] as const

const RootPackage = Schema.fromJsonString(Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }))

const installedVersions = Effect.fn("EffectVersionLockstep.installedVersions")(function*() {
  const source = `(() => { const { createRequire } = require("module"); const root = createRequire(require.resolve("./package.json")); const parent = createRequire(root.resolve("@effect/platform-node/package.json")); const packages = ["effect", "@effect/platform-node", "@effect/platform-node-shared", "@effect/sql-sqlite-node"]; const versions = packages.map((pkg) => { let file; try { file = root.resolve(pkg + "/package.json") } catch { file = parent.resolve(pkg + "/package.json") } return pkg + "\\t" + root(file).version }); return versions.join("\\n") })()`
  const report = yield* runCommand("node", ["-p", source])
  expect(report.exitCode, report.stderr).toBe(0)
  return Object.fromEntries(report.stdout.split("\n").map((line) => line.split("\t")))
})

describe("effect version lockstep", () => {
  it.live("installs all Effect packages at the exact same version", () =>
    Effect.gen(function*() {
      const versions = yield* installedVersions()
      const expected = versions.effect
      for (const pkg of EFFECT_PACKAGES) {
        const version = versions[pkg]
        expect(version, `expected ${pkg}@${String(version)} to equal effect@${String(expected)}`).toBe(expected)
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("declares the direct Effect dependencies as exact pins matching the installed version", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* Schema.decodeUnknownEffect(RootPackage)(yield* fs.readFileString("package.json"))
      const versions = yield* installedVersions()
      for (const name of DIRECT_PINS) {
        const declared = root.dependencies[name]
        expect(declared, `expected ${name} in package.json dependencies`).toBeDefined()
        expect(declared, `expected ${name} to be an exact pin, got ${String(declared)}`).toMatch(/^\d/)
        expect(declared, `expected ${name} pin to equal installed ${String(versions[name])}`).toBe(versions[name])
      }
    }).pipe(Effect.provide(NodeServices.layer)))
})
