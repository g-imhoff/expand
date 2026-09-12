import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { describe, expect } from "vitest"

const PackageJson = Schema.fromJsonString(Schema.Struct({
  engines: Schema.Struct({ node: Schema.String, npm: Schema.String }),
  packageManager: Schema.String,
  overrides: Schema.Record(Schema.String, Schema.String),
  dependencies: Schema.Record(Schema.String, Schema.String)
}))
const fixture = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return {
    pkg: yield* Schema.decodeUnknownEffect(PackageJson)(yield* fs.readFileString("package.json"))
  }
})

describe("Node and npm baseline", () => {
  it.live("pins a supported Node 24 LTS release and npm 11", () =>
    fixture.pipe(
      Effect.tap(({ pkg }) => Effect.sync(() => {
        expect(pkg.engines).toEqual({ node: ">=24.15", npm: ">=11" })
        expect(pkg.packageManager).toMatch(/^npm@11\./)
      })),
      Effect.provide(NodeServices.layer)
    ))

  it.live("pins the Effect shared platform package to the retained beta", () =>
    fixture.pipe(
      Effect.tap(({ pkg }) => Effect.sync(() => {
        expect(pkg.overrides).toEqual({
          "@effect/platform-node-shared": "4.0.0-beta.74",
          "smol-toml": "^1.7.1",
          "toml": "^4.2.0"
        })
      })),
      Effect.provide(NodeServices.layer)
    ))

  it.live("uses npm-compatible workspace dependency ranges", () =>
    fixture.pipe(
      Effect.tap(({ pkg }) => Effect.sync(() => {
        expect(pkg.dependencies["@expand/contracts"]).toBe("0.0.0")
        expect(pkg.dependencies["@expand/client-ts"]).toBe("0.0.0")
      })),
      Effect.provide(NodeServices.layer)
    ))
})
