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

  it.live.each([
    "package.json",
    "apps/desktop/package.json",
    "packages/contracts/package.json",
    "packages/client-ts/package.json",
    "docs/architecture/package.json"
  ])("rejects untracked script targets from every manifest", (manifest) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        [manifest]: encodeJson({ scripts: { missing: "tsx src/missing.ts" } })
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("untracked executable target")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    { field: "module", value: "src/missing-module.ts" },
    { field: "main", value: "src/missing-main.ts" },
    { field: "bin", value: "src/missing-bin.ts" },
    { field: "bin", value: { expand: "src/missing-bin-alias.ts", other: "src/missing-bin-alias.ts" } }
  ])("rejects untracked source targets from direct manifest fields", ({ field, value }) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {}, [field]: value })
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("untracked executable target")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    { manifest: "package.json", command: "sh scripts/missing.sh" },
    { manifest: "apps/desktop/package.json", command: "bash ./scripts/missing" },
    { manifest: "packages/contracts/package.json", command: "zsh scripts/missing.zsh" },
    { manifest: "packages/client-ts/package.json", command: "/usr/bin/env bash scripts/missing.bash" },
    { manifest: "docs/architecture/package.json", command: "env -S zsh scripts/missing.zsh" }
  ])("rejects untracked shell launch targets from every manifest", ({ manifest, command }) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        [manifest]: encodeJson({ scripts: { missing: command } })
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("untracked executable target")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("discovers shell manifest occurrences and direct extensionless bin aliases", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({
          bin: { first: "scripts/direct", second: "scripts/direct" },
          scripts: { shell: "bash scripts/first.sh && env EXPAND_MODE=test bash -e scripts/direct && sh scripts/first.sh" }
        }),
        "scripts/direct": `printf ok\n`,
        "scripts/first.sh": `printf ok\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.map(({ file, invocation }) => ({ file, invocation }))).toEqual([
        { file: "scripts/direct", invocation: { file: "package.json", selector: "manifest:bin.first", occurrence: 0 } },
        { file: "scripts/direct", invocation: { file: "package.json", selector: "manifest:bin.second", occurrence: 0 } },
        { file: "scripts/direct", invocation: { file: "package.json", selector: "manifest:scripts.shell", occurrence: 1 } },
        { file: "scripts/first.sh", invocation: { file: "package.json", selector: "manifest:scripts.shell", occurrence: 0 } },
        { file: "scripts/first.sh", invocation: { file: "package.json", selector: "manifest:scripts.shell", occurrence: 2 } }
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("fails closed for dynamic shell manifest commands", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: { dynamic: `bash "$SCRIPT"` } })
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved shell executable target")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("rejects untracked esbuild input targets", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/build.ts": `import { NodeRuntime } from "@effect/platform-node"\nimport { build } from "esbuild"\nbuild({ entryPoints: ["apps/missing.ts"] })\nNodeRuntime.${"runMain"}(null)\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("untracked executable target")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("discovers exact esbuild API inputs repository-wide", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: { secondary: "tsx tools/secondary-builder.ts" } }),
        "tools/secondary-builder.ts": `import { build as compile } from "esbuild"\nconst entries = ["apps/secondary.ts"]\nconst options = { entryPoints: entries }\ncompile(options)\n`,
        "apps/secondary.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.filter(({ invocation }) => invocation.selector.startsWith("esbuild:")).map(({ file, invocation }) => ({ file, invocation }))).toEqual([
        { file: "apps/secondary.ts", invocation: { file: "tools/secondary-builder.ts", selector: "esbuild:build", occurrence: 0 } }
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("fails closed for unresolved exact esbuild API inputs outside the canonical builder", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: { secondary: "tsx tools/secondary-builder.ts" } }),
        "tools/secondary-builder.ts": `const esbuild = require("esbuild")\nconst dead = { entryPoints: ["apps/dead.ts"] }\nvoid dead\nconst options = { entryPoints: globalThis["process"].argv.slice(2) }\nesbuild.buildSync(options)\n`,
        "apps/dead.ts": `export {}\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved executable input")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("resolves esbuild API ownership through recursive aliases in lexical scopes", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "tools/build-aliases.ts": `import esbuild, { build as importedBuild } from "esbuild"\nimport * as namespaceImport from "esbuild"\nconst defaultAlias = esbuild\ndefaultAlias.context({ entryPoints: ["apps/default.ts"] })\nconst namespaceAlias = namespaceImport\nnamespaceAlias.build({ entryPoints: ["apps/namespace.ts"] })\nconst { buildSync: namespaceSync } = namespaceAlias\nnamespaceSync({ entryPoints: ["apps/namespace-destructured.ts"] })\nconst namedAlias = importedBuild\nnamedAlias({ entryPoints: ["apps/named.ts"] })\nconst required = require("esbuild")\nconst requiredAlias = required\nrequiredAlias.build({ entryPoints: ["apps/require-namespace.ts"] })\nconst { context: requiredContext } = requiredAlias\nrequiredContext({ entryPoints: ["apps/require-destructured.ts"] })\n{ const scoped = requiredAlias; const { build: scopedBuild } = scoped; scopedBuild({ entryPoints: ["apps/scoped.ts"] }) }\nfunction shadow(esbuild: { build: (value: unknown) => void }) { esbuild.build(globalThis["process"].argv) }\nvoid shadow\n`,
        "apps/default.ts": `export {}\n`,
        "apps/namespace.ts": `export {}\n`,
        "apps/namespace-destructured.ts": `export {}\n`,
        "apps/named.ts": `export {}\n`,
        "apps/require-namespace.ts": `export {}\n`,
        "apps/require-destructured.ts": `export {}\n`,
        "apps/scoped.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.filter(({ invocation }) => invocation.selector.startsWith("esbuild:")).map(({ file, invocation }) => ({ file, selector: invocation.selector }))).toEqual([
        { file: "apps/default.ts", selector: "esbuild:context" },
        { file: "apps/named.ts", selector: "esbuild:build" },
        { file: "apps/namespace-destructured.ts", selector: "esbuild:buildSync" },
        { file: "apps/namespace.ts", selector: "esbuild:build" },
        { file: "apps/require-destructured.ts", selector: "esbuild:context" },
        { file: "apps/require-namespace.ts", selector: "esbuild:build" },
        { file: "apps/scoped.ts", selector: "esbuild:build" }
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("resolves esbuild wrapper parameters only from exact call sites", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "tools/build-wrapper.ts": `import { build } from "esbuild"\nconst invoke = (options: unknown) => build(options)\nconst forward = ({ entries }: { entries: ReadonlyArray<string> }) => invoke({ entryPoints: entries })\nconst alias = forward\nalias({ entries: ["apps/exact.ts"] })\nconst dead = { entryPoints: ["apps/missing-dead.ts"] }\nvoid dead\n`,
        "apps/exact.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.filter(({ invocation }) => invocation.selector.startsWith("esbuild:")).map(({ file, invocation }) => ({ file, invocation }))).toEqual([
        { file: "apps/exact.ts", invocation: { file: "tools/build-wrapper.ts", selector: "esbuild:build", occurrence: 0 } }
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("resolves exported esbuild wrapper parameters from exact import call sites", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "tools/build-wrapper.ts": `import { build } from "esbuild"\nexport const invoke = (options: unknown) => build(options)\nconst dead = { entryPoints: ["apps/missing-dead.ts"] }\nvoid dead\n`,
        "tools/caller.ts": `import { invoke as compile } from "./build-wrapper"\ncompile({ entryPoints: ["apps/exported-exact.ts"] })\n`,
        "apps/exported-exact.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.filter(({ invocation }) => invocation.selector.startsWith("esbuild:")).map(({ file, invocation }) => ({ file, invocation }))).toEqual([
        { file: "apps/exported-exact.ts", invocation: { file: "tools/build-wrapper.ts", selector: "esbuild:build", occurrence: 0 } }
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    `export const invoke = (options: unknown) => build(options)\n`,
    `const invoke = (options: unknown) => build(options)\ninvoke({ entryPoints: globalThis["process"].argv })\n`,
    `const invoke = (options: unknown) => build(options)\nconst other = (_options: unknown) => undefined\nconst selected = globalThis["process"].argv[2] ? invoke : other\nselected({ entryPoints: ["apps/static.ts"] })\n`
  ])("fails closed for uninvoked, dynamic, and ambiguous esbuild wrapper flow", (flow) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "tools/build-wrapper.ts": `import { build } from "esbuild"\n${flow}const dead = { entryPoints: ["apps/static.ts"] }\nvoid dead\n`,
        "apps/static.ts": `export {}\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved executable input")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("parses scope-resolved esbuild and Electron inputs structurally", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/build.ts": `import { NodeRuntime } from "@effect/platform-node"\nimport { build } from "esbuild"\nconst first = 'apps/one.ts'\nconst second = \`apps/two.ts\`\nconst entryPoints = [first, second]\nbuild({ entryPoints })\nNodeRuntime.${"runMain"}(null)\n`,
        "apps/one.ts": `export {}\n`,
        "apps/two.ts": `export {}\n`,
        "apps/desktop/electron.vite.config.ts": `import { resolve } from 'node${":"}path'\nconst here = import.meta.dirname\nconst mainInput = 'src/main/index.ts'\nconst preloadInput = \`src/preload/index.ts\`\nconst rendererInput = 'src/renderer/index.html'\nexport default { main: { build: { rollupOptions: { input: resolve(here, mainInput) } } }, preload: { build: { rollupOptions: { input: resolve(here, preloadInput) } } }, renderer: { build: { rollupOptions: { input: resolve(here, rendererInput) } } } }\n`,
        "apps/desktop/src/main/index.ts": `import { NodeRuntime } from "@effect/platform-node"\nNodeRuntime.${"runMain"}(null)\n`,
        "apps/desktop/src/preload/index.ts": `export {}\n`,
        "apps/desktop/src/renderer/index.html": `<main></main>\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.filter(({ invocation }) => invocation.selector.startsWith("esbuild:") || invocation.selector.startsWith("electron:")).map(({ file, invocation }) => ({ file, selector: invocation.selector, occurrence: invocation.occurrence }))).toEqual([
        { file: "apps/desktop/src/main/index.ts", selector: "electron:main", occurrence: 0 },
        { file: "apps/desktop/src/preload/index.ts", selector: "electron:preload", occurrence: 0 },
        { file: "apps/desktop/src/renderer/index.html", selector: "electron:renderer", occurrence: 0 },
        { file: "apps/one.ts", selector: "esbuild:build", occurrence: 0 },
        { file: "apps/two.ts", selector: "esbuild:build", occurrence: 1 }
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    { file: "scripts/build.ts", source: `import { NodeRuntime } from "@effect/platform-node"\nimport { build } from "esbuild"\nbuild({ entryPoints: globalThis["process"].argv.slice(2) })\nNodeRuntime.${"runMain"}(null)\n` },
    { file: "apps/desktop/electron.vite.config.ts", source: `const input = globalThis["process"].argv[2]\nexport default { main: { build: { rollupOptions: { input } } } }\n` }
  ])("fails closed for unresolved structural build inputs", ({ file, source }) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({ "package.json": encodeJson({ scripts: {} }), [file]: source })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved executable input")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("resolves only the exported Electron config through aliases, shorthand, and spreads", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "apps/desktop/electron.vite.config.ts": `const mainInput = "src/main/index.ts"\nconst preloadInput = "src/preload/index.ts"\nconst rendererInput = "src/renderer/index.html"\nconst mainRollup = { rollupOptions: { input: mainInput } }\nconst preloadRollup = { rollupOptions: { input: preloadInput } }\nconst rendererRollup = { rollupOptions: { input: rendererInput } }\nconst mainBuild = { build: mainRollup }\nconst main = mainBuild\nconst preload = { ...mainBuild, build: preloadRollup }\nconst rendererBase = { build: rendererRollup }\nconst renderer = { ...rendererBase }\nconst config = ({ main, ...{ preload, renderer } }) satisfies Record<string, unknown>\nexport default config\n`,
        "apps/desktop/src/main/index.ts": `import { NodeRuntime } from "@effect/platform-node"\nNodeRuntime.${"runMain"}(null)\n`,
        "apps/desktop/src/preload/index.ts": `export {}\n`,
        "apps/desktop/src/renderer/index.html": `<main></main>\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.filter(({ invocation }) => invocation.selector.startsWith("electron:")).map(({ file, invocation }) => ({ file, selector: invocation.selector }))).toEqual([
        { file: "apps/desktop/src/main/index.ts", selector: "electron:main" },
        { file: "apps/desktop/src/preload/index.ts", selector: "electron:preload" },
        { file: "apps/desktop/src/renderer/index.html", selector: "electron:renderer" }
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("does not accept an unresolved exported Electron section because a dead section is resolvable", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "apps/desktop/electron.vite.config.ts": `const dead = { main: { build: { rollupOptions: { input: "src/dead-main.ts" } } } }\nvoid dead\nconst renderer = { build: { rollupOptions: { input: globalThis["process"].argv[2] } } }\nexport default { renderer }\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved executable input")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each(["main", "preload", "renderer"])("rejects untracked Electron input targets", (section) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "apps/desktop/electron.vite.config.ts": `export default { ${section}: { build: { rollupOptions: { input: resolve(here, "src/missing.ts") } } } }\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("untracked executable target")
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

  it.live.each([
    {
      wrapperExport: `export const launch = (target: string) => spawn("node", [target])`,
      firstBarrel: `import { launch as imported } from "./wrapper"\nconst alias = imported\nexport { alias as start }`,
      secondBarrel: `export { start as run } from "./barrel-one"`,
      callerImport: `import { run as execute } from "./barrel-two"`
    },
    {
      wrapperExport: `const launch = (target: string) => spawn("node", [target])\nexport default launch`,
      firstBarrel: `import imported from "./wrapper"\nconst alias = imported\nexport { alias as start }`,
      secondBarrel: `import * as wrappers from "./barrel-one"\nconst run = wrappers.start\nexport { run }`,
      callerImport: `import { run as execute } from "./barrel-two"`
    }
  ])("resolves multi-hop ESM wrapper binding flow", ({ wrapperExport, firstBarrel, secondBarrel, callerImport }) =>
    Effect.scoped(Effect.gen(function*() {
      for (const dynamic of [false, true]) {
        const root = yield* syntheticRepository({
          "package.json": encodeJson({ scripts: {} }),
          "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\n${wrapperExport}\n`,
          "scripts/barrel-one.ts": `${firstBarrel}\n`,
          "scripts/barrel-two.ts": `${secondBarrel}\n`,
          "scripts/caller.ts": `${callerImport}\nconst local = execute\nlocal(${dynamic ? `globalThis["process"].argv[2]` : `"scripts/esm-static.ts"`})\n`,
          "scripts/esm-static.ts": `export {}\n`
        })
        if (dynamic) {
          const error = yield* Effect.flip(discoverExecutableInventory(root))
          expect(errorDetail(error)).toContain("unresolved first-party launch")
        } else {
          const discovery = yield* discoverExecutableInventory(root)
          expect(discovery.observations.map(({ file, invocation }) => ({ file, invocation }))).toEqual([
            { file: "scripts/esm-static.ts", invocation: { file: "scripts/caller.ts", selector: "child-process:scripts/esm-static.ts", occurrence: 0 } }
          ])
        }
      }
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("resolves export-star wrapper chains and rejects dynamic calls after static proof", () =>
    Effect.scoped(Effect.gen(function*() {
      const staticRoot = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`,
        "scripts/barrel-one.ts": `export * from "./wrapper"\n`,
        "scripts/barrel-two.ts": `export * from "./barrel-one"\n`,
        "scripts/caller.ts": `import { launch } from "./barrel-two"\nlaunch("scripts/star-static.ts")\n`,
        "scripts/star-static.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(staticRoot)
      expect(discovery.observations.map(({ file }) => file)).toEqual(["scripts/star-static.ts"])

      const dynamicRoot = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`,
        "scripts/barrel.ts": `export * from "./wrapper"\n`,
        "scripts/caller.ts": `import { launch } from "./barrel"\nlaunch("scripts/star-static.ts")\nlaunch(globalThis["process"].argv[2])\n`,
        "scripts/star-static.ts": `export {}\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(dynamicRoot))
      expect(errorDetail(error)).toContain("unresolved first-party launch")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    {
      files: {
        "scripts/a.ts": `export * from "./left"\nexport * from "./right"\n`,
        "scripts/left.ts": `export { launch } from "./wrapper"\n`,
        "scripts/right.ts": `export { launch } from "./other"\n`,
        "scripts/other.ts": `export const launch = (_target: string) => undefined\n`,
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`
      },
      detail: "ambiguous"
    },
    {
      files: {
        "scripts/a.ts": `export * from "./b"\n`,
        "scripts/b.ts": `export * from "./a"\n`
      },
      detail: "cyclic"
    }
  ])("fails closed for ambiguous and cyclic export-star callable flow", ({ files, detail }) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        ...files,
        "scripts/caller.ts": `import { launch } from "./a"\nlaunch("scripts/star-target.ts")\n`,
        "scripts/star-target.ts": `export {}\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain(detail)
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("resolves function-local dynamic-import bindings in exported declarations", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`,
        "scripts/caller.ts": `export as${"ync"} function execute() {\n  const namespace = (a${"wait"} (import("./wrapper")))\n  const { launch: destructured } = namespace\n  const property = namespace["launch"]\n  const local = property\n  destructured("scripts/function-dynamic-one.ts")\n  local("scripts/function-dynamic-two.ts")\n}\n`,
        "scripts/function-dynamic-one.ts": `export {}\n`,
        "scripts/function-dynamic-two.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.map(({ file }) => file)).toEqual([
        "scripts/function-dynamic-one.ts",
        "scripts/function-dynamic-two.ts"
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("resolves static dynamic-import wrapper aliases and preserves shadowing", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`,
        "scripts/barrel-one.ts": `export * from "./wrapper"\n`,
        "scripts/barrel-two.ts": `export * from "./barrel-one"\n`,
        "scripts/caller.ts": `const { launch: destructured } = a${"wait"} import("./barrel-two")\nconst namespace = a${"wait"} import("./barrel-two")\nconst property = namespace.launch\nconst local = property\nfunction shadow(local: (target: string) => void) { local("scripts/shadowed.ts") }\nvoid shadow\ndestructured("scripts/dynamic-import-one.ts")\nlocal("scripts/dynamic-import-two.ts")\n`,
        "scripts/dynamic-import-one.ts": `export {}\n`,
        "scripts/dynamic-import-two.ts": `export {}\n`,
        "scripts/shadowed.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(root)
      expect(discovery.observations.map(({ file }) => file)).toEqual([
        "scripts/dynamic-import-one.ts",
        "scripts/dynamic-import-two.ts"
      ])
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    `const moduleName = globalThis["process"].argv[2]\nconst namespace = a${"wait"} import(moduleName)\nnamespace.launch("scripts/dynamic-module.ts")\n`,
    `const namespace = a${"wait"} import("./wrapper")\nconst callable = globalThis["process"].argv[2] ? namespace.launch : globalThis["noop"]\ncallable("scripts/dynamic-callable.ts")\n`
  ])("fails closed for dynamic import specifiers and unproven callable flow", (caller) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`,
        "scripts/caller.ts": caller,
        "scripts/dynamic-module.ts": `export {}\n`,
        "scripts/dynamic-callable.ts": `export {}\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved first-party callable")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("fails closed for cyclic dynamic-import export flow", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/a.ts": `export * from "./b"\n`,
        "scripts/b.ts": `export * from "./a"\n`,
        "scripts/caller.ts": `const { launch } = a${"wait"} import("./a")\nlaunch("scripts/cycle-dynamic.ts")\n`,
        "scripts/cycle-dynamic.ts": `export {}\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("cyclic")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("resolves namespace export-star wrapper flow and rejects dynamic calls after static proof", () =>
    Effect.scoped(Effect.gen(function*() {
      const staticRoot = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`,
        "scripts/barrel.ts": `export * as tools from "./wrapper"\n`,
        "scripts/caller.ts": `import { tools } from "./barrel"\nconst namespace = tools\nconst execute = namespace.launch\nexecute("scripts/namespace-star-static.ts")\n`,
        "scripts/namespace-star-static.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(staticRoot)
      expect(discovery.observations.map(({ file }) => file)).toEqual(["scripts/namespace-star-static.ts"])

      const dynamicRoot = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`,
        "scripts/barrel.ts": `export * as tools from "./wrapper"\n`,
        "scripts/caller.ts": `import { tools } from "./barrel"\ntools.launch("scripts/namespace-star-static.ts")\ntools.launch(globalThis["process"].argv[2])\n`,
        "scripts/namespace-star-static.ts": `export {}\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(dynamicRoot))
      expect(errorDetail(error)).toContain("unresolved first-party launch")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("propagates namespace exports through ordinary export-star barrels", () =>
    Effect.scoped(Effect.gen(function*() {
      const staticRoot = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`,
        "scripts/namespace.ts": `export * as tools from "./wrapper"\n`,
        "scripts/middle.ts": `export * from "./namespace"\n`,
        "scripts/barrel.ts": `export * from "./middle"\n`,
        "scripts/caller.ts": `import { tools } from "./barrel"\ntools.launch("scripts/propagated-namespace.ts")\n`,
        "scripts/propagated-namespace.ts": `export {}\n`
      })
      const discovery = yield* discoverExecutableInventory(staticRoot)
      expect(discovery.observations.map(({ file }) => file)).toEqual(["scripts/propagated-namespace.ts"])

      const dynamicRoot = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`,
        "scripts/namespace.ts": `export * as tools from "./wrapper"\n`,
        "scripts/barrel.ts": `export * from "./namespace"\n`,
        "scripts/caller.ts": `import { tools } from "./barrel"\ntools.launch("scripts/propagated-namespace.ts")\ntools.launch(globalThis["process"].argv[2])\n`,
        "scripts/propagated-namespace.ts": `export {}\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(dynamicRoot))
      expect(errorDetail(error)).toContain("unresolved first-party launch")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live.each([
    {
      files: {
        "scripts/barrel.ts": `export * as tools from "./left"\nexport { tools } from "./right"\n`,
        "scripts/left.ts": `export { launch } from "./wrapper"\n`,
        "scripts/right.ts": `export * as tools from "./other"\n`,
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`,
        "scripts/other.ts": `export const launch = (_target: string) => undefined\n`
      },
      detail: "ambiguous"
    },
    {
      files: {
        "scripts/barrel.ts": `export * as tools from "./cycle"\nexport * from "./cycle"\n`,
        "scripts/cycle.ts": `export * from "./barrel"\n`
      },
      detail: "cyclic"
    },
    {
      files: {
        "scripts/barrel.ts": `export * from "./left"\nexport * from "./right"\n`,
        "scripts/left.ts": `export * as tools from "./wrapper"\n`,
        "scripts/right.ts": `export * as tools from "./other"\n`,
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`,
        "scripts/other.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`
      },
      detail: "ambiguous"
    },
    {
      files: {
        "scripts/barrel.ts": `export * from "./cycle"\n`,
        "scripts/cycle.ts": `export * from "./barrel"\nexport * from "./namespace"\n`,
        "scripts/namespace.ts": `export * as tools from "./wrapper"\n`,
        "scripts/wrapper.ts": `import { spawn } from "node${":"}child_process"\nexport const launch = (target: string) => spawn("node", [target])\n`
      },
      detail: "cyclic"
    }
  ])("fails closed for ambiguous and cyclic namespace export flow", ({ files, detail }) =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        ...files,
        "scripts/caller.ts": `import { tools } from "./barrel"\ntools.launch("scripts/namespace-star-target.ts")\n`,
        "scripts/namespace-star-target.ts": `export {}\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain(detail)
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("rejects dot-segment paths before generated-output filtering", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {}, main: "dist/../scripts/missing.ts" })
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("untracked executable target")
    }).pipe(Effect.provide(NodeServices.layer))), 120_000)

  it.live("fails closed for cyclic ESM wrapper binding flow", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* syntheticRepository({
        "package.json": encodeJson({ scripts: {} }),
        "scripts/a.ts": `import { launch as imported } from "./b"\nconst launch = imported\nexport { launch }\n`,
        "scripts/b.ts": `import { launch as imported } from "./a"\nconst launch = imported\nexport { launch }\n`,
        "scripts/caller.ts": `import { launch } from "./a"\nlaunch("scripts/cycle-target.ts")\n`,
        "scripts/cycle-target.ts": `export {}\n`
      })
      const error = yield* Effect.flip(discoverExecutableInventory(root))
      expect(errorDetail(error)).toContain("unresolved first-party launch")
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
