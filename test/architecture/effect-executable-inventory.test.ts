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
  function*(files: Readonly<Record<string, string>>, executableFiles: ReadonlyArray<string> = []) {
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
    for (const file of executableFiles) yield* run(root, "git", ["update-index", "--chmod=+x", file])
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

  it.live("fails before inventory comparison for native, aliased, and wrapped launch forms", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "effect-executable-inventory.json": encodeJson({ version: 1, entrypoints: [] }),
        "package.json": encodeJson({ scripts: {} }),
        "scripts/constants.ts": `export const importedTarget = "scripts/imported.ts"\n`,
        "scripts/wrapper.ts": `import { spawn as nativeSpawn } from "node${":"}child_process"\nexport const launch = (target: string) => nativeSpawn("node", [target])\n`,
        "scripts/caller.ts": `import { ChildProcess as Process } from "effect/unstable/process"\nimport * as EffectProcess from "effect/unstable/process"\nimport * as EffectChild from "effect/unstable/process/ChildProcess"\nimport { make as makeEffectChild } from "effect/unstable/process/ChildProcess"\nimport * as native from "child_process"\nimport legacy = require("child_process")\nimport { exec as execute, execFileSync as syncLaunch, execSync as syncExecute, fork as forkChild, spawnSync as syncSpawn } from "node${":"}child_process"\nimport { importedTarget } from "./constants"\nimport { launch as wrappedLaunch } from "./wrapper"\nconst required = require("node${":"}child_process")\nconst nativeAlias = native\nconst directRequired = require("child_process").spawn\nconst { execFile: requiredLaunch } = require("child_process")\nconst { spawn: destructuredAlias } = required\nconst localTarget = "scripts/local.ts"\nconst localAlias = syncSpawn\nProcess.make("node", ["scripts/effect.ts"])\nEffectProcess.ChildProcess.make("node", ["scripts/effect-root.ts"])\nEffectChild.make("node", ["scripts/effect-module.ts"])\nmakeEffectChild("node", ["scripts/effect-direct.ts"])\nnative.spawn("node", [localTarget])\nexecute("node scripts/exec.ts")\nsyncExecute("node scripts/exec-sync.ts")\nlocalAlias("node", ["scripts/spawn-sync.ts"])\nsyncLaunch("node", [importedTarget])\nrequiredLaunch("node", ["scripts/required.ts"])\nrequired.spawn("node", ["scripts/require-namespace.ts"])\nnativeAlias.spawn("node", ["scripts/namespace-alias.ts"])\ndirectRequired("node", ["scripts/require-property.ts"])\ndestructuredAlias("node", ["scripts/require-destructure-alias.ts"])\nlegacy.spawn("node", ["scripts/import-equals.ts"])\nforkChild("scripts/forked.ts")\nwrappedLaunch(importedTarget)\n`,
        "scripts/effect.ts": `export {}\n`,
        "scripts/effect-root.ts": `export {}\n`,
        "scripts/effect-module.ts": `export {}\n`,
        "scripts/effect-direct.ts": `export {}\n`,
        "scripts/exec.ts": `export {}\n`,
        "scripts/exec-sync.ts": `export {}\n`,
        "scripts/spawn-sync.ts": `export {}\n`,
        "scripts/require-namespace.ts": `export {}\n`,
        "scripts/namespace-alias.ts": `export {}\n`,
        "scripts/require-property.ts": `export {}\n`,
        "scripts/require-destructure-alias.ts": `export {}\n`,
        "scripts/import-equals.ts": `export {}\n`,
        "scripts/local.ts": `export {}\n`,
        "scripts/imported.ts": `export {}\n`,
        "scripts/required.ts": `export {}\n`,
        "scripts/forked.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.map(({ file, invocation }) => ({ file, invocation }))).toEqual([
        { file: "scripts/effect-direct.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/effect-direct.ts", occurrence: 0 } },
        { file: "scripts/effect-module.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/effect-module.ts", occurrence: 0 } },
        { file: "scripts/effect-root.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/effect-root.ts", occurrence: 0 } },
        { file: "scripts/effect.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/effect.ts", occurrence: 0 } },
        { file: "scripts/exec-sync.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/exec-sync.ts", occurrence: 0 } },
        { file: "scripts/exec.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/exec.ts", occurrence: 0 } },
        { file: "scripts/forked.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/forked.ts", occurrence: 0 } },
        { file: "scripts/import-equals.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/import-equals.ts", occurrence: 0 } },
        { file: "scripts/imported.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/imported.ts", occurrence: 0 } },
        { file: "scripts/imported.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/imported.ts", occurrence: 1 } },
        { file: "scripts/local.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/local.ts", occurrence: 0 } },
        { file: "scripts/namespace-alias.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/namespace-alias.ts", occurrence: 0 } },
        { file: "scripts/require-destructure-alias.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/require-destructure-alias.ts", occurrence: 0 } },
        { file: "scripts/require-namespace.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/require-namespace.ts", occurrence: 0 } },
        { file: "scripts/require-property.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/require-property.ts", occurrence: 0 } },
        { file: "scripts/required.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/required.ts", occurrence: 0 } },
        { file: "scripts/spawn-sync.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/spawn-sync.ts", occurrence: 0 } }
      ])
      const error = yield* Effect.flip(validateExecutableInventory(root))
      expect(errorDetail(error)).toContain("absent from inventory")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("collects lexical local launch aliases without leaking through shadowing", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/caller.ts": `import { spawn } from "node${":"}child_process"
function direct() {
  const { spawn: launch } = require("child_process")
  launch("node", ["scripts/direct.ts"])
}
const wrapped = (target: string) => {
  const { spawn: launch } = require("node${":"}child_process")
  launch("node", [target])
}
function shadowed(spawn: (command: string, args: Array<string>) => void) {
  spawn("node", ["scripts/shadowed.ts"])
}
direct()
wrapped("scripts/wrapped.ts")
void shadowed
void spawn
`,
        "scripts/direct.ts": `export {}\n`,
        "scripts/shadowed.ts": `export {}\n`,
        "scripts/wrapped.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.map(({ file }) => file)).toEqual(["scripts/direct.ts", "scripts/wrapped.ts"])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("resolves child launch bindings by exact lexical scope", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/caller.ts": `import cpDefault from "node${":"}child_process"
import * as cpNamespace from "child_process"
import { spawn as importedSpawn } from "node${":"}child_process"
const namespaceAlias = cpNamespace
const { spawn: defaultLaunch } = cpDefault
const { spawn: namespaceLaunch } = namespaceAlias
const namedAlias = importedSpawn
function functionScope() {
  const launch = namedAlias
  launch("node", ["scripts/function.ts"])
}
try {
  throw new Error("scope")
} catch (caught) {
  const launch = namespaceLaunch
  launch("node", ["scripts/catch.ts"])
  void caught
}
for (const launch of [defaultLaunch]) {
  launch("node", ["scripts/loop.ts"])
}
{
  const launch = defaultLaunch
  launch("node", ["scripts/block.ts"])
}
const requireAlias = require
const requiredNamespace = requireAlias("child_process")
const { spawn: requiredLaunch } = requiredNamespace
requiredLaunch("node", ["scripts/required.ts"])
function shadowedRequire(require: (specifier: string) => { spawn: typeof importedSpawn }) {
  const { spawn: falseLaunch } = require("child_process")
  falseLaunch("node", ["scripts/shadowed-require.ts"])
}
try {
  throw defaultLaunch
} catch (defaultLaunch) {
  defaultLaunch("node", ["scripts/shadowed-catch.ts"])
}
for (const namespaceLaunch of [(_: string, __: Array<string>) => undefined]) {
  namespaceLaunch("node", ["scripts/shadowed-loop.ts"])
}
{
  const importedSpawn = (_: string, __: Array<string>) => undefined
  importedSpawn("node", ["scripts/shadowed-block.ts"])
}
functionScope()
void shadowedRequire
`,
        "scripts/block.ts": `export {}\n`,
        "scripts/catch.ts": `export {}\n`,
        "scripts/function.ts": `export {}\n`,
        "scripts/loop.ts": `export {}\n`,
        "scripts/required.ts": `export {}\n`,
        "scripts/shadowed-block.ts": `export {}\n`,
        "scripts/shadowed-catch.ts": `export {}\n`,
        "scripts/shadowed-loop.ts": `export {}\n`,
        "scripts/shadowed-require.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.map(({ file }) => file)).toEqual([
        "scripts/block.ts",
        "scripts/catch.ts",
        "scripts/function.ts",
        "scripts/loop.ts",
        "scripts/required.ts"
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("resolves recursively nested wrappers and destructured parameter flow", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/caller.ts": `import { spawn } from "node${":"}child_process"
function outer() {
  function declaration(target: string) {
    spawn("node", [target])
  }
  const expression = function({ target }: { target: string }) {
    spawn("node", [target])
  }
  const arrow = ({ target: renamed }: { target: string }) => {
    spawn("node", [renamed])
  }
  const wrappers = {
    method({ target }: { target: string }) {
      spawn("node", [target])
    }
  }
  const nested = ({ target }: { target: string }) => declaration(target)
  expression({ target: "scripts/expression.ts" })
  arrow({ target: "scripts/arrow.ts" })
  wrappers.method({ target: "scripts/method.ts" })
  nested({ target: "scripts/nested.ts" })
}
outer()
`,
        "scripts/arrow.ts": `export {}\n`,
        "scripts/expression.ts": `export {}\n`,
        "scripts/method.ts": `export {}\n`,
        "scripts/nested.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.map(({ file }) => file)).toEqual([
        "scripts/arrow.ts",
        "scripts/expression.ts",
        "scripts/method.ts",
        "scripts/nested.ts"
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("fails closed for dynamic destructured wrapper arguments", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/caller.ts": `import { spawn } from "node${":"}child_process"
const launch = ({ target }: { target: string }) => spawn("node", [target])
launch({ target: globalThis["process"].argv[2] })
`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved first-party launch")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("fails closed for unresolved same-file and imported wrapper arguments", () =>
    Effect.scoped(Effect.gen(function*() {
      for (const imported of [false, true]) {
        const root = yield* syntheticRepository({
          "package.json": encodeJson({ scripts: {} }),
          ...(imported ? { "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n` } : {}),
          "scripts/caller.ts": imported
            ? `import { launch } from "./wrapper"\nlaunch(globalThis["process"].argv[2])\n`
            : `import { spawn } from "node${":"}child_process"\nconst launch = (target: string) => spawn("node", [target])\nlaunch(globalThis["process"].argv[2])\n`
        })
        const error = yield* Effect.flip(discoverExecutableInventory(root))
        expect(errorDetail(error)).toContain("unresolved first-party launch")
      }
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    `import { spawn } from "node${":"}child_process"\nspawn(globalThis["process"].argv[2], ["status"])\n`,
    `import { execFile } from "node${":"}child_process"\nexecFile(globalThis["process"].env.EXECUTABLE, ["--version"])\n`,
    `import { fork } from "node${":"}child_process"\nfork(globalThis["process"].argv[2])\n`
  ])("fails closed for dynamic child command paths", (source) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/caller.ts": source
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved child command")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    {
      file: "scripts/caller.ts",
      source: `import { spawn } from "node${":"}child_process"\nexport function launch(target: string) { spawn(target, ["status"]) }\n`
    },
    {
      file: "packages/client-ts/adapters/node-spawn.ts",
      source: `import { spawn } from "node${":"}child_process"\nexport function unrelated(command: string) { spawn(command, ["status"]) }\n`
    }
  ])("fails closed for declaration-level dynamic child commands", ({ file, source }) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        [file]: source
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved child command")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    `import { spawn } from "node${":"}child_process"\nspawn("node", ["scripts/missing.ts"])\n`,
    `import { spawn } from "node${":"}child_process"\nconst missing = "scripts/missing.ts"\nconst args = [missing]\nspawn("node", args)\n`
  ])("fails closed for resolved untracked source-like child targets", (source) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/caller.ts": source
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("untracked first-party launch target")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    { callerImport: `import launch from "./wrapper"`, extraFiles: {} },
    { callerImport: `import launch from "./re-export"`, extraFiles: { "scripts/re-export.ts": `export { default } from "./wrapper"\n` } }
  ])("resolves direct and re-exported default variable wrappers", ({ callerImport, extraFiles }) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nconst launch = (target: string) => spawn("node", [target])\nexport default launch\n`,
        "scripts/caller.ts": `${callerImport}\nlaunch("scripts/default-static.ts")\n`,
        "scripts/default-static.ts": `export {}\n`,
        ...extraFiles
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.map(({ file, invocation }) => ({ file, invocation }))).toEqual([
        { file: "scripts/default-static.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/default-static.ts", occurrence: 0 } }
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    { callerImport: `import launch from "./wrapper"`, extraFiles: {} },
    { callerImport: `import launch from "./re-export"`, extraFiles: { "scripts/re-export.ts": `export { default } from "./wrapper"\n` } }
  ])("fails closed for dynamic direct and re-exported default variable wrappers", ({ callerImport, extraFiles }) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nconst launch = function(target: string) { spawn("node", [target]) }\nexport default launch\n`,
        "scripts/caller.ts": `${callerImport}\nlaunch(globalThis["process"].argv[2])\n`,
        ...extraFiles
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved first-party launch")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("resolves export-equals wrappers through import-equals local aliases without leaking shadowed names", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nconst launch = (target: string) => spawn("node", [target])\nexport = launch\n`,
        "scripts/caller.ts": `import launch = require("./wrapper")\nconst alias = launch\nfunction shadow(alias: (target: string) => void) { alias("scripts/shadowed.ts") }\nvoid shadow\nalias("scripts/export-equals-static.ts")\n`,
        "scripts/export-equals-static.ts": `export {}\n`,
        "scripts/shadowed.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.map(({ file, invocation }) => ({ file, invocation }))).toEqual([
        { file: "scripts/export-equals-static.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/export-equals-static.ts", occurrence: 0 } }
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("fails closed for dynamic export-equals wrappers through import-equals aliases", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nconst launch = function(target: string) { spawn("node", [target]) }\nexport = launch\n`,
        "scripts/caller.ts": `import launch = require("./wrapper")\nconst alias = launch\nalias(globalThis["process"].argv[2])\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved first-party launch")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    { exportClause: "export { launch as default }", callerImport: `import launch from "./wrapper"` },
    { exportClause: "const middle = launch\nconst exposed = middle\nexport { exposed as start }", callerImport: `import { start as launch } from "./wrapper"` }
  ])("resolves local export aliases without module specifiers", ({ exportClause, callerImport }) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nconst launch = (target: string) => spawn("node", [target])\n${exportClause}\n`,
        "scripts/caller.ts": `${callerImport}\nlaunch("scripts/local-export-static.ts")\n`,
        "scripts/local-export-static.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.map(({ file, invocation }) => ({ file, invocation }))).toEqual([
        { file: "scripts/local-export-static.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/local-export-static.ts", occurrence: 0 } }
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("fails closed for dynamic local export alias chains", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nconst launch = (target: string) => spawn("node", [target])\nconst middle = launch\nexport { middle as start }\n`,
        "scripts/caller.ts": `import { start } from "./wrapper"\nstart(globalThis["process"].argv[2])\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved first-party launch")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    { argument: `"scripts/export-chain-static.ts"`, dynamic: false },
    { argument: `globalThis["process"].argv[2]`, dynamic: true }
  ])("resolves transitive import-equals and export-equals wrapper chains", ({ argument, dynamic }) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nconst launch = (target: string) => spawn("node", [target])\nexport = launch\n`,
        "scripts/barrel-one.ts": `import launch = require("./wrapper")\nconst alias = launch\nexport = alias\n`,
        "scripts/barrel-two.ts": `import launch = require("./barrel-one")\nconst alias = launch\nexport = alias\n`,
        "scripts/caller.ts": `import launch = require("./barrel-two")\nlaunch(${argument})\n`,
        "scripts/export-chain-static.ts": `export {}\n`
      })
      if (dynamic) {
        const error = yield* Effect.flip(discoverExecutableInventory(root))
        expect(errorDetail(error)).toContain("unresolved first-party launch")
      } else {
        const discovery = yield* discoverExecutableInventory(root)
        expect(discovery.observations.map(({ file, invocation }) => ({ file, invocation }))).toEqual([
          { file: "scripts/export-chain-static.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/export-chain-static.ts", occurrence: 0 } }
        ])
      }
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("fails closed for cyclic import-equals and export-equals callable flow", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/a.ts": `import launch = require("./b")\nexport = launch\n`,
        "scripts/b.ts": `import launch = require("./a")\nexport = launch\n`,
        "scripts/caller.ts": `import launch = require("./a")\nlaunch("scripts/cycle-target.ts")\n`,
        "scripts/cycle-target.ts": `export {}\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved first-party launch")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    { file: "scripts/host.bash", source: "#!/usr/bin/env bash\nprintf ok\n" },
    { file: "scripts/host.zsh", source: "#!/usr/bin/env zsh\nprintf ok\n" },
    { file: "scripts/host", source: "#!/bin/sh\nprintf ok\n" }
  ])("discovers mode-100644 shebangs in every tracked regular file", ({ file, source }) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        [file]: source
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain(`unregistered host executable: ${file}`)
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("excludes tracked non-shebang binary and text files from host discovery", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "assets/data.bin": `\u0000#!not-at-start`,
        "scripts/plain.bash": `printf ok\n`,
        "scripts/plain.zsh": `printf ok\n`,
        "scripts/plain": `printf ok\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("accepts scope-resolved external and inline child commands without inventing entrypoints", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/caller.ts": `import { exec, execFile, spawn } from "node${":"}child_process"
const external = "git"
const alias = external
const launch = (command: string) => spawn(command, ["status"])
launch(alias)
execFile("/usr/bin/env", ["true"])
exec("printf ok")
spawn("bash", ["-c", "printf ok"])
spawn("node", ["-e", "void 0"])
`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("resolves zero-parameter, local-alias, returned, and immediately invoked wrapper paths", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/caller.ts": `import { spawn } from "node${":"}child_process"
const zero = () => spawn("node", ["scripts/zero.ts"])
const first = zero
const second = first
const returned = (target: string) => () => spawn("node", [target])
const localFactory = () => {
  const local = (target: string) => spawn("node", [target])
  return local
}
second()
returned("scripts/returned.ts")()
localFactory()("scripts/local.ts")
;((target: string) => spawn("node", [target]))("scripts/iife.ts")
`,
        "scripts/iife.ts": `export {}\n`,
        "scripts/local.ts": `export {}\n`,
        "scripts/returned.ts": `export {}\n`,
        "scripts/zero.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.map(({ file }) => file)).toEqual([
        "scripts/iife.ts",
        "scripts/local.ts",
        "scripts/returned.ts",
        "scripts/zero.ts"
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    `import { spawn } from "node${":"}child_process"\nconst returned = (target: string) => () => spawn("node", [target])\nreturned(globalThis["process"].argv[2])()\n`,
    `import { spawn } from "node${":"}child_process"\nconst factory = () => { const local = (target: string) => spawn("node", [target]); return local }\nfactory()(globalThis["process"].env.TARGET)\n`
  ])("fails closed when returned or local wrapper flow cannot be proven", (source) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/caller.ts": source
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved first-party launch")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("discovers direct require property and element child launches", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/caller.ts": `require("child_process").spawn("node", ["scripts/property.ts"])
require("node${":"}child_process")["execFile"]("node", ["scripts/element.ts"])
`,
        "scripts/element.ts": `export {}\n`,
        "scripts/property.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.map(({ file, invocation }) => ({ file, invocation }))).toEqual([
        { file: "scripts/element.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/element.ts", occurrence: 0 } },
        { file: "scripts/property.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/property.ts", occurrence: 0 } }
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    `const target = globalThis["process"].argv[2]\nrequire("child_process").spawn("node", [target])\n`,
    `import { spawn } from "node${":"}child_process"\nconst target = globalThis["process"].argv[2]\nspawn("tsx", [target])\n`,
    `import { execFile } from "node${":"}child_process"\nconst args = globalThis["process"].argv.slice(2)\nexecFile("npx", args)\n`
  ])("fails discovery for unresolved interpreter and package-runner launches", (source) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/caller.ts": source
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved first-party launch")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("fails discovery when a second tracked caller consumes the host fixture", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const fixture = yield* fs.readFileString(yield* path.fromFileUrl(new URL("../../scripts/fixtures/job-control.sh", import.meta.url)))
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/fixtures/job-control.sh": fixture,
        "scripts/fixture-owner.ts": `import { ChildProcess } from "effect/unstable/process"\nconst JOB_CONTROL_FIXTURE = "scripts/fixtures/job-control.sh"\nChildProcess.make("bash", [JOB_CONTROL_FIXTURE])\n`,
        "scripts/second.ts": `import { spawn } from "node${":"}child_process"\nspawn("bash", ["scripts/fixtures/job-control.sh"])\n`
      }, ["scripts/fixtures/job-control.sh"])
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("exactly one")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each(
    [`node${":"}test`, "fs", `node${":"}sqlite`, "sqlite"].flatMap((specifier) => [
      `import value from "${specifier}"`,
      `import { value as alias } from "${specifier}"`,
      `import "${specifier}"`,
      `const value = import("${specifier}")`,
      `const value = require("${specifier}")`,
      `const loader = require; const value = loader("${specifier}")`,
      `export { value } from "${specifier}"`,
      `export * from "${specifier}"`,
      `import value = require("${specifier}")`
    ])
  )("rejects every Node builtin preload syntax and specifier form through actual discovery", (source) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "apps/desktop/src/preload/index.ts": source
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("preload transport shim")
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

  it.live.each([
    `const builtin = "node${":"}fs"\nimport(builtin)\n`,
    `const builtin = "fs"\nconst alias = builtin\nconst loader = require\nloader(alias)\n`,
    `import(globalThis["process"].env.PRELOAD_MODULE)\n`,
    `require(globalThis["process"].argv[2])\n`
  ])("fails closed for resolved forbidden and unresolved dynamic preload specifiers", (source) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "apps/desktop/src/preload/index.ts": source
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("preload transport shim")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("ignores a genuinely shadowed preload require", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "apps/desktop/src/preload/index.ts": `function transport(require: (specifier: string) => unknown) { return require(globalThis["process"].argv[2]) }\nvoid transport\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.map(({ file }) => file)).toEqual([])
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

  it.live.each([
    `import { Effect } from "effect"\nfunction nested() { Effect.${"runPromise"}(Effect.void) }\nvoid nested\n`,
    `import { Effect } from "effect"\nconst nested = () => Effect.void.pipe(Effect.${"runPromise"})\nvoid nested\n`,
    `import { NodeRuntime } from "@effect/platform-node"\nconst outer = () => { const launch = NodeRuntime.${"runMain"}; return (program: never) => launch(program) }\nvoid outer\n`
  ])("fails independently discovered real runners in nested scopes", (source) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/runner.ts": source
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toMatch(/runner/)
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("fails independently discovered unregistered and multiple module runners", () =>
    Effect.scoped(Effect.gen(function*() {
      for (const source of [
        `import { Effect } from "effect"\nEffect.${"runPromise"}(Effect.void)\n`,
        `import { Effect } from "effect"\nEffect.${"runPromise"}(Effect.void)\nEffect.${"runPromise"}(Effect.void)\n`,
        `import { Effect as Runtime } from "effect"\nRuntime.${"runPromise"}(Runtime.void)\n`,
        `import { runMain as launch } from "@effect/platform-node/NodeRuntime"\nlaunch(null)\n`,
        `import { NodeRuntime as Runtime } from "@effect/platform-node"\nconst launch = Runtime.${"runMain"}\nlaunch(null)\n`,
        `import * as PlatformNode from "@effect/platform-node"\nconst Runtime = PlatformNode.NodeRuntime\nconst launch = Runtime.${"runMain"}\nlaunch(null)\n`,
        `import { Effect } from "effect"\nEffect.void.pipe(Effect.${"runPromise"})\n`,
        `import { Effect } from "effect"\nconst launch = Effect.${"runPromise"}\nEffect.void.pipe(launch)\n`,
        `import { runPromise as launch } from "effect"\nimport { Effect } from "effect"\nEffect.void.pipe(launch)\n`,
        `import { Effect } from "effect"\nimport { NodeRuntime as Runtime } from "@effect/platform-node"\nconst launch = Runtime.${"runMain"}\nEffect.void.pipe(launch)\n`
      ]) {
        const root = yield* syntheticRepository({
          "package.json": encodeJson({ scripts: {} }),
          "scripts/runner.ts": source
        })
        const error = yield* Effect.flip(discoverExecutableInventory(root))
        expect(errorDetail(error)).toMatch(/runner/)
      }
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("resolves runner destructuring and aliases without leaking through shadows", () =>
    Effect.scoped(Effect.gen(function*() {
      for (const source of [
        `import NodeRuntime from "@effect/platform-node/NodeRuntime"\nconst { runMain: launch } = NodeRuntime\nlaunch(null)\n`,
        `import * as NodeRuntime from "@effect/platform-node/NodeRuntime"\nconst Runtime = NodeRuntime\nconst { runMain } = Runtime\nconst launch = runMain\nvoid [null].map(launch)\n`,
        `import { NodeRuntime } from "@effect/platform-node"\nconst { runMain: launch } = NodeRuntime\nvoid [null].map(launch)\n`
      ]) {
        const root = yield* syntheticRepository({
          "package.json": encodeJson({ scripts: {} }),
          "scripts/runner.ts": source
        })
        const error = yield* Effect.flip(discoverExecutableInventory(root))
        expect(errorDetail(error)).toMatch(/runner/)
      }

      const shadowedRoot = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/runner.ts": `import { runMain as launch } from "@effect/platform-node/NodeRuntime"
function callback(launch: (value: unknown) => unknown) {
  void [null].map(launch)
}
{
  const launch = (value: unknown) => value
  void [null].map(launch)
}
void callback
void launch
`
      })
      const discovery = yield* discoverExecutableInventory(shadowedRoot)
      expect(discovery.observations).toEqual([])
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
      const expectedSequence = decoded.entrypoints.flatMap(({ invokedBy }) => invokedBy)
      expect(expectedSequence).toHaveLength(93)
      expect(discovery.observations.map(({ invocation }) => invocation)).toEqual(expectedSequence)
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
    }).pipe(Effect.provide(NodeServices.layer)), 120_000)
})
