import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { describe, expect } from "vitest"

type OverrideValue = string | { readonly [key: string]: OverrideValue }

const Override: Schema.Codec<OverrideValue> = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.suspend(() => Override))
])
const Overrides = Schema.Record(Schema.String, Override)

const PackageJson = Schema.fromJsonString(Schema.Struct({
  engines: Schema.Struct({ node: Schema.String, npm: Schema.String }),
  packageManager: Schema.String,
  overrides: Overrides,
  dependencies: Schema.Record(Schema.String, Schema.String)
}))
const fixture = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return {
    pkg: yield* Schema.decodeUnknownEffect(PackageJson)(yield* fs.readFileString("package.json"))
  }
})

describe("Node and npm baseline", () => {
  it("accepts supported npm override forms", () => {
    const overrides = {
      "@effect/platform-node-shared": "4.0.0",
      tsup: { esbuild: "^0.28.2" },
      "parent@^2": { ".": "2.1.0", child: { nested: "$effect" } }
    }
    expect(Schema.decodeUnknownSync(Overrides)(overrides)).toEqual(overrides)
  })

  it.each([null, 2, true, ["1.0.0"], { child: { nested: false } }])(
    "rejects invalid npm override values: %j",
    (value) => {
      expect(() => Schema.decodeUnknownSync(Overrides)({ parent: value })).toThrow()
    }
  )

  it.live("retains the tsup esbuild constraint", () =>
    fixture.pipe(
      Effect.tap(({ pkg }) => Effect.sync(() => {
        expect(pkg.overrides["tsup"]).toEqual({ esbuild: "^0.28.2" })
      })),
      Effect.provide(NodeServices.layer)
    ))

  it.live("pins a supported Node 24 LTS release and npm 11", () =>
    fixture.pipe(
      Effect.tap(({ pkg }) => Effect.sync(() => {
        expect(pkg.engines).toEqual({ node: ">=24.15", npm: ">=11" })
        expect(pkg.packageManager).toMatch(/^npm@11\./)
      })),
      Effect.provide(NodeServices.layer)
    ))

  it.live("pins the Effect shared platform package to the stable release", () =>
    fixture.pipe(
      Effect.tap(({ pkg }) => Effect.sync(() => {
        expect(pkg.overrides["@effect/platform-node-shared"]).toBe("4.0.0")
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
