import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { describe, expect } from "vitest"

const PackageJson = Schema.fromJsonString(Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String)
}))

describe("package certification architecture", () => {
  it.effect("registers one Effect package certification entrypoint", () => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const source = yield* fs.readFileString("scripts/package-certification.ts")
    const manifest = yield* fs.readFileString("package.json").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PackageJson))
    )
    expect(manifest.scripts["verify:package-artifacts"]).toBe("tsx scripts/package-certification.ts")
    expect(source.match(/NodeRuntime(?:\["runMain"\]|\.runMain)\(/g)).toHaveLength(1)
  }).pipe(Effect.provide(NodeServices.layer)))
})
