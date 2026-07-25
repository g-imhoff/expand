import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { describe, expect } from "vitest"
import {
  ExecutableInventoryError,
  ExecutableInventoryJson,
  discoverExecutableInventory,
  validateExecutableInventory
} from "../../scripts/effect-executable-inventory"

const PackageJson = Schema.fromJsonString(Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String)
}))

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

const errorDetail = (error: unknown) => {
  expect(error).toBeInstanceOf(ExecutableInventoryError)
  return error instanceof ExecutableInventoryError ? error.detail : String(error)
}

const run = Effect.fn("ExecutableInventoryTest.run")((cwd: string, command: string, args: ReadonlyArray<string>) =>
  Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd }))
    yield* handle.stdout.pipe(Stream.runDrain)
    yield* handle.stderr.pipe(Stream.runDrain)
    const exitCode = yield* handle.exitCode
    expect(exitCode).toBe(0)
  })))

const syntheticRepository = Effect.fn("ExecutableInventoryTest.syntheticRepository")(
  function*(files: Readonly<Record<string, string>>) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-executable-inventory-" })
    for (const [file, source] of Object.entries(files)) {
      const target = path.join(root, file)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, source)
    }
    yield* run(root, "git", ["init", "-q"])
    yield* run(root, "git", ["add", "."])
    return root
  }
)

describe("exact executable inventory architecture", () => {
  it.live("independently discovers every manifest and repeated child invocation occurrence", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: { many: "tsx scripts/first.ts && tsx scripts/second.ts && tsx scripts/first.ts" } }),
        "scripts/caller.ts": `import { ChildProcess } from "effect/unstable/process"\nconst target = "scripts/child-only.ts"\nChildProcess.make("node", [target])\nChildProcess.make("node", [target])\n`,
        "scripts/child-only.ts": `export {}\n`,
        "scripts/first.ts": `export {}\n`,
        "scripts/not-an-entry.ts": `export {}\n`,
        "scripts/second.ts": `export {}\n`,
        "scripts/synthetic-fixture.test.ts": "const syntheticChildProcessSource = `ChildProcess.make(\"node\", [\"scripts/not-an-entry.ts\"])`\nvoid syntheticChildProcessSource\n"
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.filter(({ file, invocation }) => file === "scripts/first.ts" && invocation.selector === "manifest:scripts.many").map(({ invocation }) => invocation.occurrence)).toEqual([0, 2])
      expect(discovery.observations.filter(({ file, invocation }) => file === "scripts/second.ts" && invocation.selector === "manifest:scripts.many").map(({ invocation }) => invocation.occurrence)).toEqual([1])
      expect(discovery.observations.filter(({ file }) => file === "scripts/child-only.ts").map(({ invocation }) => invocation.occurrence)).toEqual([0, 1])
      expect(discovery.observations.some(({ file }) => file === "scripts/not-an-entry.ts")).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("fails validation when an independently discovered child-only program is absent", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "effect-executable-inventory.json": encodeJson({ version: 1, entrypoints: [] }),
        "package.json": encodeJson({ scripts: {} }),
        "scripts/caller.ts": `import { ChildProcess } from "effect/unstable/process"\nChildProcess.make("node", ["scripts/child-only.ts"])\n`,
        "scripts/child-only.ts": `export {}\n`
      })
      const error = yield* Effect.flip(validateExecutableInventory(root))
      expect(errorDetail(error)).toContain("absent from inventory")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("rejects preload module drift through actual repository discovery", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "apps/desktop/src/preload/index.ts": `const loader = require\nloader("node${":"}fs")\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("preload transport shim")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("fails independently discovered unregistered and multiple module runners", () =>
    Effect.scoped(Effect.gen(function*() {
      for (const source of [
        `import { Effect } from "effect"\nEffect.${"runPromise"}(Effect.void)\n`,
        `import { Effect } from "effect"\nEffect.${"runPromise"}(Effect.void)\nEffect.${"runPromise"}(Effect.void)\n`,
        `import { Effect as Runtime } from "effect"\nRuntime.${"runPromise"}(Runtime.void)\n`
      ]) {
        const root = yield* syntheticRepository({
          "package.json": encodeJson({ scripts: {} }),
          "scripts/runner.ts": source
        })
        const error = yield* Effect.flip(discoverExecutableInventory(root))
        expect(errorDetail(error)).toMatch(/runner/)
      }
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

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
