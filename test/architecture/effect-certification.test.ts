import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { describe, expect } from "vitest"
import { effectHostBoundaries } from "../../eslint-rules/effect-host-boundaries.mjs"

const PackageJson = Schema.fromJsonString(Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String)
}))

const nodeRuntimeRunner = ["runner:NodeRuntime", "runMain"].join(".")

const workflowGates = [
  "lint",
  "typecheck:all",
  "arch",
  "knip",
  "test",
  "cert:packages",
  "bench:selfcheck",
  "bench:events -- --smoke",
  "cert:cli:build",
  "build:desktop",
  "e2e:desktop"
] as const

describe("package certification architecture", () => {
  it.effect("registers one Effect package certification entrypoint", () => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const source = yield* fs.readFileString("scripts/package-certification.ts")
    const manifest = yield* fs.readFileString("package.json").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PackageJson))
    )
    expect(manifest.scripts["cert:packages"]).toBe("tsx scripts/package-certification.ts")
    expect(source.match(/NodeRuntime(?:\["runMain"\]|\.runMain)\(/g)).toHaveLength(1)
    expect(effectHostBoundaries.filter((entry) => entry.file === "scripts/package-certification.ts" && entry.construct === nodeRuntimeRunner)).toEqual([
      expect.objectContaining({ declaration: "module:<module>", occurrence: 0 })
    ])
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps the complete CI certification matrix", () => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const workflow = yield* fs.readFileString(".github/workflows/ci.yml")
    for (const gate of workflowGates) expect(workflow).toContain(gate)
  }).pipe(Effect.provide(NodeServices.layer)))
})
