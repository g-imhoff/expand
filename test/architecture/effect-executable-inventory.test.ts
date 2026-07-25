import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  ExecutableInventoryJson,
  discoverExecutableInventory,
  validateExecutableInventory
} from "../../scripts/effect-executable-inventory"

const PackageJson = Schema.fromJsonString(Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String)
}))

describe("exact executable inventory architecture", () => {
  it.live("proves a strict live bijection across every independently discovered executable source", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const report = yield* validateExecutableInventory(root)
      const discovery = yield* discoverExecutableInventory(root)

      expect(report.entrypointCount).toBe(discovery.entrypointCount)
      expect(report.observationCount).toBe(discovery.observations.length)
      expect(report.entrypointCount).toBeGreaterThan(0)
      expect(discovery.observations.some(({ invocation }) => invocation.selector.startsWith("manifest:"))).toBe(true)
      expect(discovery.observations.some(({ invocation }) => invocation.selector.startsWith("esbuild:"))).toBe(true)
      expect(discovery.observations.some(({ invocation }) => invocation.selector.startsWith("electron:"))).toBe(true)
      expect(discovery.observations.some(({ invocation }) => invocation.selector.startsWith("runner:"))).toBe(true)
      expect(discovery.observations.some(({ invocation }) => invocation.selector === "example-entry")).toBe(true)
      expect(discovery.observations.some(({ invocation }) => invocation.selector === "benchmark-entry")).toBe(true)
      expect(discovery.observations.some(({ invocation }) => invocation.selector.startsWith("child-process:"))).toBe(true)
      expect([...new Set(discovery.observations.filter(({ kind }) => kind === "registered-host-fixture").map(({ file }) => file))]).toEqual([
        "scripts/fixtures/job-control.sh"
      ])

      const decoded = yield* Schema.decodeUnknownEffect(ExecutableInventoryJson)(
        yield* fs.readFileString(path.join(root, "effect-executable-inventory.json"))
      )
      expect(decoded.entrypoints).toHaveLength(discovery.entrypointCount)
      expect(decoded.entrypoints.map(({ file }) => file)).toContain("test/architecture/effect-executable-inventory.test.ts")
    }).pipe(Effect.provide(NodeServices.layer)), 120_000)

  it.live("wires the permanent launcher gate without an inventory update command", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const packageJson = yield* Schema.decodeUnknownEffect(PackageJson)(
        yield* fs.readFileString(path.join(root, "package.json"))
      )

      expect(packageJson.scripts["effect:launchers"]).toBe("vitest run test/architecture/effect-executable-inventory.test.ts")
      expect(Object.keys(packageJson.scripts).filter((name) => /launcher.*(?:update|generate)|(?:update|generate).*launcher/.test(name))).toEqual([])
      expect(yield* fs.exists(path.join(root, "effect-launchers.json"))).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("keeps preload as the sole Effect-free transport shim", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const discovery = yield* discoverExecutableInventory(root)
      const shims = [...new Set(discovery.observations.filter(({ kind }) => kind === "effect-free-transport-shim").map(({ file }) => file))]

      expect(shims).toEqual(["apps/desktop/src/preload/index.ts"])
    }).pipe(Effect.provide(NodeServices.layer)))
})
