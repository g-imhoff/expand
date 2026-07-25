import { Crypto, Data, Effect, Encoding, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { effectHostBoundaries } from "../eslint-rules/effect-host-boundaries.mjs"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

export const ExecutableDeclaration = Schema.Struct({
  kind: Schema.String,
  name: Schema.String
})

export const InvocationLink = Schema.Struct({
  file: Schema.String,
  selector: Schema.String,
  occurrence: NonNegativeInt
})

export const HostBoundaryLink = Schema.Struct({
  declaration: ExecutableDeclaration,
  construct: Schema.String,
  occurrence: NonNegativeInt
})

export const ExecutableInventory = Schema.Struct({
  version: Schema.Literal(1),
  entrypoints: Schema.Array(Schema.Struct({
    file: Schema.String,
    declaration: ExecutableDeclaration,
    kind: Schema.Literals([
      "effect-entrypoint",
      "effect-free-transport-shim",
      "registered-host-launcher",
      "registered-host-fixture"
    ]),
    invokedBy: Schema.Array(InvocationLink),
    hostBoundary: Schema.optional(HostBoundaryLink),
    sourceHash: Schema.optional(Sha256)
  }))
})

export const ExecutableInventoryJson = Schema.fromJsonString(ExecutableInventory)

export type ExecutableInventoryValue = typeof ExecutableInventory.Type
export type ExecutableEntrypoint = ExecutableInventoryValue["entrypoints"][number]
export type ExecutableKind = ExecutableEntrypoint["kind"]
export type Invocation = typeof InvocationLink.Type
export type BoundaryLink = typeof HostBoundaryLink.Type

export interface ExecutableObservation {
  readonly file: string
  readonly declaration: typeof ExecutableDeclaration.Type
  readonly kind: ExecutableKind
  readonly invocation: Invocation
  readonly hostBoundary?: BoundaryLink
  readonly sourceHash?: string
}

export class ExecutableInventoryError extends Data.TaggedError("ExecutableInventoryError")<{
  readonly detail: string
  readonly cause?: unknown
}> {}

export interface ExecutableDiscovery {
  readonly observations: ReadonlyArray<ExecutableObservation>
  readonly trackedFiles: ReadonlyArray<string>
  readonly trackedModes: ReadonlyMap<string, string>
  readonly sourceHashes: ReadonlyMap<string, string>
  readonly entrypointCount: number
}

interface ValidationContext {
  readonly trackedFiles: ReadonlyArray<string>
  readonly trackedModes: ReadonlyMap<string, string>
  readonly sourceHashes: ReadonlyMap<string, string>
}

const fail = (detail: string, cause?: unknown) => new ExecutableInventoryError({
  detail,
  ...(cause === undefined ? {} : { cause })
})

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

const validPath = (file: string) =>
  file.length > 0
  && !file.startsWith("/")
  && !file.includes("\\")
  && !file.endsWith("/")
  && !/[*?\[\]{}]/.test(file)
  && file.split("/").every((part) => part !== "" && part !== "." && part !== "..")

const declarationKey = (declaration: typeof ExecutableDeclaration.Type) =>
  `${declaration.kind}:${declaration.name}`

const boundaryKey = (boundary: BoundaryLink | undefined) => boundary === undefined
  ? ""
  : `${declarationKey(boundary.declaration)}\u0000${boundary.construct}\u0000${boundary.occurrence}`

const invocationKey = (link: Invocation) =>
  `${link.file}\u0000${link.selector}\u0000${link.occurrence}`

const observationKey = (observation: ExecutableObservation) =>
  `${observation.file}\u0000${invocationKey(observation.invocation)}`

const parseDeclaration = (value: string): typeof ExecutableDeclaration.Type => {
  const separator = value.indexOf(":")
  return separator < 0
    ? { kind: "unknown", name: value }
    : { kind: value.slice(0, separator), name: value.slice(separator + 1) }
}

const sameEntrypointIdentity = (entrypoint: ExecutableEntrypoint, observation: ExecutableObservation) =>
  declarationKey(entrypoint.declaration) === declarationKey(observation.declaration)
  && entrypoint.kind === observation.kind
  && boundaryKey(entrypoint.hostBoundary) === boundaryKey(observation.hostBoundary)
  && entrypoint.sourceHash === observation.sourceHash

export const validateExecutableInventoryRecords = Effect.fn("ExecutableInventory.validateRecords")(
  function*(input: unknown, observations: ReadonlyArray<ExecutableObservation>, context: ValidationContext) {
    const inventory = yield* Schema.decodeUnknownEffect(ExecutableInventory)(input).pipe(
      Effect.mapError((cause) => fail(`inventory schema decode failed: ${String(cause)}`, cause))
    )
    const tracked = new Set(context.trackedFiles)
    const files = inventory.entrypoints.map(({ file }) => file)
    if (inventory.entrypoints.some(({ file }) => !validPath(file))) {
      return yield* fail("inventory contains a malformed repository-relative path")
    }
    if (files.some((file) => !tracked.has(file))) {
      return yield* fail("inventory contains an untracked path")
    }
    if (new Set(files).size !== files.length) {
      return yield* fail("inventory contains duplicate entrypoint paths or declarations")
    }
    const sortedFiles = [...files].sort(compareText)
    if (files.some((file, index) => file !== sortedFiles[index])) {
      return yield* fail("inventory entrypoints are not sorted by path")
    }
    const observationKeys = observations.map(observationKey)
    if (new Set(observationKeys).size !== observationKeys.length) {
      return yield* fail("discovery contains duplicate invocation identities")
    }

    const observationsByFile = new Map<string, Array<ExecutableObservation>>()
    for (const observation of observations) {
      const existing = observationsByFile.get(observation.file) ?? []
      existing.push(observation)
      observationsByFile.set(observation.file, existing)
    }
    if (observationsByFile.size !== inventory.entrypoints.length) {
      return yield* fail("inventory and discovery entrypoint counts differ")
    }

    for (const entrypoint of inventory.entrypoints) {
      const discovered = observationsByFile.get(entrypoint.file)
      if (discovered === undefined || discovered.length === 0) {
        return yield* fail(`inventory entrypoint is not independently discovered: ${entrypoint.file}`)
      }
      if (discovered.some((observation) => !sameEntrypointIdentity(entrypoint, observation))) {
        const first = discovered[0]!
        if (declarationKey(entrypoint.declaration) !== declarationKey(first.declaration)) {
          return yield* fail(`declaration drift: ${entrypoint.file}`)
        }
        if (entrypoint.kind !== first.kind) return yield* fail(`kind drift: ${entrypoint.file}`)
        if (boundaryKey(entrypoint.hostBoundary) !== boundaryKey(first.hostBoundary)) {
          return yield* fail(`host boundary drift: ${entrypoint.file}`)
        }
        return yield* fail(`source hash drift: ${entrypoint.file}`)
      }
      if (entrypoint.invokedBy.some((link) => !validPath(link.file) || !tracked.has(link.file))) {
        return yield* fail(`invocation link is not a tracked file: ${entrypoint.file}`)
      }
      const links = entrypoint.invokedBy.map(invocationKey)
      if (new Set(links).size !== links.length) {
        return yield* fail(`duplicate invocation link: ${entrypoint.file}`)
      }
      const expectedLinks = discovered.map(({ invocation }) => invocationKey(invocation)).sort(compareText)
      const actualLinks = [...links].sort(compareText)
      if (actualLinks.length !== expectedLinks.length || actualLinks.some((key, index) => key !== expectedLinks[index])) {
        return yield* fail(`invocation bijection failed: ${entrypoint.file}`)
      }
      if (entrypoint.kind === "registered-host-launcher" && entrypoint.file !== ".githooks/pre-commit") {
        return yield* fail(`registered host launcher is not exact: ${entrypoint.file}`)
      }
      if (entrypoint.kind === "registered-host-fixture" && (
        entrypoint.file !== "scripts/fixtures/job-control.sh"
        || entrypoint.invokedBy.length !== 1
        || entrypoint.invokedBy[0]?.selector !== "host-primitive:job-control"
      )) {
        return yield* fail(`registered host fixture must have one exact invocation and primitive boundary: ${entrypoint.file}`)
      }
      if (entrypoint.kind === "effect-free-transport-shim" && entrypoint.file !== "apps/desktop/src/preload/index.ts") {
        return yield* fail(`Effect-free transport shim is not the preload entry: ${entrypoint.file}`)
      }
      const hostKind = entrypoint.kind === "registered-host-launcher" || entrypoint.kind === "registered-host-fixture"
      if (hostKind) {
        if (context.trackedModes.get(entrypoint.file) !== "100755") {
          return yield* fail(`host executable requires exact Git mode 100755: ${entrypoint.file}`)
        }
        if (entrypoint.sourceHash === undefined || context.sourceHashes.get(entrypoint.file) !== entrypoint.sourceHash) {
          return yield* fail(`host executable hash is stale: ${entrypoint.file}`)
        }
      } else if (entrypoint.sourceHash !== undefined) {
        return yield* fail(`non-host entrypoint cannot carry a source hash: ${entrypoint.file}`)
      }
      const runnerLinks = entrypoint.invokedBy.filter(({ selector }) => selector.startsWith("runner:"))
      if ((entrypoint.hostBoundary === undefined ? 0 : runnerLinks.length) !== (entrypoint.hostBoundary === undefined ? 0 : 1)) {
        return yield* fail(`runner must be linked exactly once: ${entrypoint.file}`)
      }
    }

    for (const observation of observations) {
      if (!inventory.entrypoints.some(({ file }) => file === observation.file)) {
        return yield* fail(`discovered executable is absent from inventory: ${observation.file}`)
      }
    }
    return inventory
  }
)

const commandOutput = Effect.fn("ExecutableInventory.commandOutput")(
  (root: string, command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: root })).pipe(
        Effect.mapError((cause) => fail(`${command} could not start`, cause))
      )
      const [stdout, stderr, exitCode] = yield* Effect.all([
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode
      ], { concurrency: "unbounded" }).pipe(
        Effect.mapError((cause) => fail(`${command} failed`, cause))
      )
      if (exitCode !== 0) return yield* fail(`${command} exited ${exitCode}: ${stderr}`)
      return stdout
    }))
)

const manifestFiles = [
  "package.json",
  "apps/desktop/package.json",
  "packages/contracts/package.json",
  "packages/client-ts/package.json",
  "docs/architecture/package.json"
] as const

const Manifest = Schema.fromJsonString(Schema.Struct({
  module: Schema.optionalKey(Schema.String),
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
}))

const sourcePathPattern = /(?:^|\s|["'])([A-Za-z0-9_./-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|html))(?:$|\s|["'])/g

const executableKind = (file: string): ExecutableKind => {
  if (file === ".githooks/pre-commit") return "registered-host-launcher"
  if (file === "scripts/fixtures/job-control.sh") return "registered-host-fixture"
  if (file === "apps/desktop/src/preload/index.ts") return "effect-free-transport-shim"
  return "effect-entrypoint"
}

const defaultDeclaration = (file: string): typeof ExecutableDeclaration.Type =>
  file.endsWith(".html")
    ? { kind: "document", name: "<document>" }
    : file.endsWith(".sh") || file.startsWith(".githooks/")
      ? { kind: "script", name: "<script>" }
      : { kind: "module", name: "<module>" }

const boundaryForFile = (file: string): BoundaryLink | undefined => {
  const boundaries = effectHostBoundaries.filter((boundary) =>
    boundary.file === file
    && boundary.declaration === "module:<module>"
    && boundary.construct.startsWith("runner:")
  )
  if (boundaries.length !== 1) return undefined
  const boundary = boundaries[0]!
  return {
    declaration: parseDeclaration(boundary.declaration),
    construct: boundary.construct,
    occurrence: boundary.occurrence
  }
}

const makeObservation = (
  file: string,
  invocation: Invocation,
  sourceHash?: string
): ExecutableObservation => {
  const hostBoundary = boundaryForFile(file)
  return {
    file,
    declaration: hostBoundary?.declaration ?? defaultDeclaration(file),
    kind: executableKind(file),
    invocation,
    ...(hostBoundary === undefined ? {} : { hostBoundary }),
    ...(sourceHash === undefined ? {} : { sourceHash })
  }
}

const normalizeManifestPath = (manifest: string, file: string) => {
  const directory = manifest === "package.json" ? "" : manifest.slice(0, manifest.lastIndexOf("/") + 1)
  const joined = `${directory}${file}`
  const parts: Array<string> = []
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return parts.join("/")
}

export const discoverExecutableInventory = Effect.fn("ExecutableInventory.discover")(
  function*(root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const trackedOutput = yield* commandOutput(root, "git", ["ls-files", "-s", "-z"])
    const trackedFiles: Array<string> = []
    const trackedModes = new Map<string, string>()
    for (const record of trackedOutput.split("\0").filter(Boolean)) {
      const match = /^(\d{6}) [0-9a-f]+ 0\t(.+)$/.exec(record)
      if (match === null || !validPath(match[2] ?? "")) return yield* fail("git tracked-mode output is malformed")
      const file = match[2]!
      trackedFiles.push(file)
      trackedModes.set(file, match[1]!)
    }
    const tracked = new Set(trackedFiles)
    const sourceHashes = new Map<string, string>()
    const observations: Array<ExecutableObservation> = []
    const add = (file: string, invocation: Invocation) => {
      if (tracked.has(file)) observations.push(makeObservation(file, invocation, sourceHashes.get(file)))
    }

    const shebangOutput = yield* commandOutput(root, "git", ["grep", "-Il", "^#!", "--", "."])
    const shebangFiles: Array<string> = []
    for (const file of shebangOutput.split(/\r?\n/).filter(Boolean)) {
      if (!tracked.has(file)) continue
      const source = yield* fs.readFileString(path.join(root, file)).pipe(Effect.mapError((cause) => fail(`cannot read ${file}`, cause)))
      if (source.startsWith("#!")) shebangFiles.push(file)
    }
    const selectedHosts = [...new Set([
      ...trackedFiles.filter((file) => trackedModes.get(file) === "100755"),
      ...shebangFiles
    ])].sort(compareText)
    for (const file of selectedHosts) {
      if (file !== ".githooks/pre-commit" && file !== "scripts/fixtures/job-control.sh") {
        return yield* fail(`unregistered host executable: ${file}`)
      }
      const bytes = yield* fs.readFile(path.join(root, file)).pipe(Effect.mapError((cause) => fail(`cannot hash ${file}`, cause)))
      const digest = yield* crypto.digest("SHA-256", bytes).pipe(Effect.mapError((cause) => fail(`cannot hash ${file}`, cause)))
      sourceHashes.set(file, Encoding.encodeHex(digest))
      const invocation = file === ".githooks/pre-commit"
        ? { file, selector: "host:git-pre-commit", occurrence: 0 }
        : { file: "scripts/binary-smoke.ts", selector: "host-primitive:job-control", occurrence: 0 }
      observations.push(makeObservation(file, invocation, sourceHashes.get(file)))
    }

    for (const manifestFile of manifestFiles) {
      const manifest = yield* Schema.decodeUnknownEffect(Manifest)(
        yield* fs.readFileString(path.join(root, manifestFile)).pipe(Effect.mapError((cause) => fail(`cannot read ${manifestFile}`, cause)))
      ).pipe(Effect.mapError((cause) => fail(`cannot decode ${manifestFile}`, cause)))
      if (manifest.module !== undefined) {
        add(normalizeManifestPath(manifestFile, manifest.module), { file: manifestFile, selector: "manifest:module", occurrence: 0 })
      }
      for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
        if (!/^tsx\s+|^node\b.*(?:--import\s+tsx|--import=tsx)|^vitest\s+run\s+/.test(command)) continue
        for (const match of command.matchAll(sourcePathPattern)) {
          const candidate = match[1]
          if (candidate === undefined) continue
          const file = normalizeManifestPath(manifestFile, candidate)
          if (tracked.has(file)) {
            add(file, { file: manifestFile, selector: `manifest:scripts.${name}`, occurrence: 0 })
            break
          }
        }
      }
    }

    const buildSource = yield* fs.readFileString(path.join(root, "scripts/build.ts")).pipe(
      Effect.mapError((cause) => fail("cannot read scripts/build.ts", cause))
    )
    let buildOccurrence = 0
    for (const match of buildSource.matchAll(/\["([^"]+\.(?:ts|tsx))",\s*"dist\//g)) {
      const file = match[1]
      if (file !== undefined) add(file, { file: "scripts/build.ts", selector: "esbuild:BUILD_ENTRIES", occurrence: buildOccurrence++ })
    }

    const electronConfig = yield* fs.readFileString(path.join(root, "apps/desktop/electron.vite.config.ts")).pipe(
      Effect.mapError((cause) => fail("cannot read Electron config", cause))
    )
    for (const match of electronConfig.matchAll(/\b(main|preload|renderer):\s*\{[\s\S]*?input:\s*resolve\(here,\s*"([^"]+)"\)/g)) {
      const target = match[1]
      const relative = match[2]
      if (target !== undefined && relative !== undefined) {
        add(`apps/desktop/${relative}`, {
          file: "apps/desktop/electron.vite.config.ts",
          selector: `electron:${target}`,
          occurrence: 0
        })
      }
    }

    const moduleRunners = effectHostBoundaries.filter((boundary) =>
      boundary.declaration === "module:<module>" && boundary.construct.startsWith("runner:")
    )
    for (const boundary of moduleRunners) {
      const source = yield* fs.readFileString(path.join(root, boundary.file)).pipe(
        Effect.mapError((cause) => fail(`cannot read runner ${boundary.file}`, cause))
      )
      if (!/(?:runMain|runPromise|runPromiseExit|runSync|runSyncExit|runFork|runCallback)/.test(source)) {
        return yield* fail(`registered module runner is stale: ${boundary.file}`)
      }
      add(boundary.file, {
        file: boundary.file,
        selector: boundary.construct,
        occurrence: boundary.occurrence
      })
    }

    for (const file of [...new Set(moduleRunners.map(({ file }) => file))]) {
      if (file.startsWith("examples/") && !file.includes("/test/")) {
        add(file, { file, selector: "example-entry", occurrence: 0 })
      }
      if (file.startsWith("bench/")) {
        add(file, { file, selector: "benchmark-entry", occurrence: 0 })
      }
    }

    const candidateFiles = [...new Set(observations.map(({ file }) => file))]
    for (const caller of trackedFiles.filter((file) =>
      /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)
      && file !== "scripts/effect-executable-inventory.ts"
      && file !== "scripts/effect-executable-inventory.test.ts"
      && file !== "test/architecture/effect-executable-inventory.test.ts"
    )) {
      const source = yield* fs.readFileString(path.join(root, caller)).pipe(Effect.mapError((cause) => fail(`cannot read ${caller}`, cause)))
      if (!/(?:ChildProcess\.make|spawnExample\s*\(|runExample\s*\(|sourceEntry\s*:)/.test(source)) continue
      for (const target of candidateFiles) {
        if (target === "scripts/fixtures/job-control.sh") continue
        const basename = target.slice(target.lastIndexOf("/") + 1)
        const exactIndex = source.indexOf(target)
        const exampleIndex = target.startsWith("examples/") ? source.indexOf(`"${basename}"`) : -1
        const index = exactIndex >= 0 ? exactIndex : exampleIndex
        if (index >= 0 && caller !== target) {
          add(target, { file: caller, selector: `child-process:${target}`, occurrence: 0 })
        }
      }
    }

    const preload = "apps/desktop/src/preload/index.ts"
    const preloadSource = yield* fs.readFileString(path.join(root, preload)).pipe(
      Effect.mapError((cause) => fail(`cannot read ${preload}`, cause))
    )
    if (/from\s+["'](?:effect|@effect\/|@effect\/platform-node)/.test(preloadSource)) {
      return yield* fail("preload transport shim imports Effect or Node platform services")
    }

    const unique = new Map<string, ExecutableObservation>()
    for (const observation of observations) unique.set(observationKey(observation), observation)
    const sorted = [...unique.values()].sort((left, right) =>
      compareText(left.file, right.file) || compareText(invocationKey(left.invocation), invocationKey(right.invocation))
    )
    return {
      observations: sorted,
      trackedFiles: [...trackedFiles].sort(compareText),
      trackedModes,
      sourceHashes,
      entrypointCount: new Set(sorted.map(({ file }) => file)).size
    }
  }
)

export const validateExecutableInventory = Effect.fn("ExecutableInventory.validate")(
  function*(root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const discovery = yield* discoverExecutableInventory(root)
    const inventoryFile = path.join(root, "effect-executable-inventory.json")
    const raw = yield* fs.readFileString(inventoryFile).pipe(
      Effect.mapError((cause) => fail("effect-executable-inventory.json is missing", cause))
    )
    const inventory = yield* Schema.decodeUnknownEffect(ExecutableInventoryJson)(raw).pipe(
      Effect.mapError((cause) => fail(`inventory JSON decode failed: ${String(cause)}`, cause))
    )
    const canonical = yield* Schema.encodeEffect(ExecutableInventoryJson)(inventory).pipe(
      Effect.mapError((cause) => fail(`inventory JSON encode failed: ${String(cause)}`, cause))
    )
    if (raw !== canonical) return yield* fail("inventory JSON is not canonical")
    const validated = yield* validateExecutableInventoryRecords(inventory, discovery.observations, discovery)
    return {
      entrypointCount: validated.entrypoints.length,
      observationCount: discovery.observations.length
    }
  }
)
