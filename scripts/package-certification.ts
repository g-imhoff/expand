import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Context, Data, Effect, Exit, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { stage as stageContracts } from "../packages/contracts/scripts/prepare-publish"
import { stage as stageClient } from "../packages/client-ts/scripts/prepare-publish"

export const Workspace = Schema.Literals(["@expand/contracts", "@expand/client-ts", "@expand/electron-ipc", "@expand/ink-input"])
export type Workspace = typeof Workspace.Type

export class PackageCertificationError extends Data.TaggedError("PackageCertificationError")<{
  readonly workspace: Workspace
  readonly phase: "build" | "stage" | "pack" | "inspect"
  readonly detail: string
  readonly cause?: unknown
}> {}

export interface PackageCertificationReport {
  readonly workspace: Workspace
  readonly packageName: string
  readonly filename: string
  readonly files: ReadonlyArray<string>
  readonly exports: Readonly<Record<string, unknown>>
  readonly version: string
  readonly dependencies: Readonly<Record<string, string>>
}

export interface PackageCertificationCommandRequest {
  readonly workspace: Workspace
  readonly phase: "build" | "stage" | "pack" | "inspect"
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
}

export interface PackageCertificationCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export class PackageCertificationCommandRunner extends Context.Service<PackageCertificationCommandRunner, {
  readonly run: (request: PackageCertificationCommandRequest) => Effect.Effect<PackageCertificationCommandResult, PackageCertificationError>
}>()("expand/PackageCertificationCommandRunner") {}

export class PackageStager extends Context.Service<PackageStager, {
  readonly stage: (workspace: Workspace, root: string, version: string) => Effect.Effect<void, PackageCertificationError>
}>()("expand/PackageStager") {}

const PackFile = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  mode: Schema.Number
})

const PackMetadata = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  size: Schema.Number,
  unpackedSize: Schema.Number,
  shasum: Schema.String,
  integrity: Schema.String,
  filename: Schema.String,
  files: Schema.Array(PackFile),
  entryCount: Schema.Number,
  bundled: Schema.Array(Schema.String)
})

export const PackMetadataJson = Schema.fromJsonString(Schema.Array(PackMetadata))

const PublishedManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.Boolean,
  type: Schema.Literal("module"),
  files: Schema.Array(Schema.String),
  exports: Schema.Record(Schema.String, Schema.Unknown),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

const SourceManifest = Schema.Struct({
  name: Schema.String,
  type: Schema.Literal("module"),
  sideEffects: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

export interface TarEntry {
  readonly path: string
  readonly type: "file" | "directory" | "link"
}

const workspaces = [
  { name: "@expand/contracts", directory: "packages/contracts", build: "workspace" },
  { name: "@expand/client-ts", directory: "packages/client-ts", build: "workspace" },
  {
    name: "@expand/electron-ipc",
    directory: "packages/electron-ipc",
    build: [
      "contract.ts", "main.ts", "preload.ts", "renderer.ts",
      "--format", "esm", "--dts", "--out-dir", "dist", "--target", "es2022",
      "--platform", "neutral", "--external", "effect", "--external", "electron", "--clean", "--splitting"
    ]
  },
  {
    name: "@expand/ink-input",
    directory: "packages/ink-input",
    build: [
      "index.ts", "--format", "esm", "--dts", "--out-dir", "dist", "--target", "es2022",
      "--platform", "neutral", "--external", "ink", "--external", "react", "--clean"
    ]
  }
] as const

const clientExports = {
  ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
  "./project": { types: "./dist/project/index.d.ts", import: "./dist/project/index.js", default: "./dist/project/index.js" },
  "./server": { types: "./dist/server/index.d.ts", import: "./dist/server/index.js", default: "./dist/server/index.js" },
  "./adapters/node": { types: "./dist/adapters/node.d.ts", import: "./dist/adapters/node.js", default: "./dist/adapters/node.js" },
  "./package.json": "./package.json"
} as const

const contractsExports = {
  "./events/domain-event": null,
  "./package.json": "./package.json",
  "./*": { types: "./dist/*.d.ts", import: "./dist/*.js", default: "./dist/*.js" }
} as const

const electronIpcExports = {
  "./contract": { types: "./dist/contract.d.ts", import: "./dist/contract.js", default: "./dist/contract.js" },
  "./main": { types: "./dist/main.d.ts", import: "./dist/main.js", default: "./dist/main.js" },
  "./preload": { types: "./dist/preload.d.ts", import: "./dist/preload.js", default: "./dist/preload.js" },
  "./renderer": { types: "./dist/renderer.d.ts", import: "./dist/renderer.js", default: "./dist/renderer.js" },
  "./package.json": "./package.json"
} as const

const inkInputExports = {
  ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
  "./package.json": "./package.json"
} as const

const expectedExportsFor = (workspace: Workspace): Readonly<Record<string, unknown>> => workspace === "@expand/contracts"
  ? contractsExports
  : workspace === "@expand/client-ts"
    ? clientExports
    : workspace === "@expand/electron-ipc"
      ? electronIpcExports
      : inkInputExports

const failure = (workspace: Workspace, phase: PackageCertificationError["phase"], detail: string, cause?: unknown) =>
  new PackageCertificationError({ workspace, phase, detail, ...(cause === undefined ? {} : { cause }) })

const stageBuiltLibrary = Effect.fn("PackageCertification.stageBuiltLibrary")(
  function*(workspace: "@expand/electron-ipc" | "@expand/ink-input", root: string, version: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dist = path.join(root, "dist")
    if (!(yield* fs.exists(dist).pipe(Effect.mapError((cause) => failure(workspace, "stage", "built package could not be checked", cause))))) {
      return yield* failure(workspace, "stage", "built package was missing")
    }
    const source = yield* fs.readFileString(path.join(root, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SourceManifest))),
      Effect.mapError((cause) => failure(workspace, "stage", "source package manifest could not be read", cause))
    )
    if (source.name !== workspace) return yield* failure(workspace, "stage", "source package name did not match workspace")
    const target = path.join(root, "dist-publish")
    yield* fs.makeDirectory(target, { recursive: true }).pipe(
      Effect.mapError((cause) => failure(workspace, "stage", "publish staging directory could not be created", cause))
    )
    yield* fs.copy(dist, path.join(target, "dist")).pipe(
      Effect.mapError((cause) => failure(workspace, "stage", "built package could not be staged", cause))
    )
    const manifest = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
      name: workspace,
      version,
      private: false,
      type: source.type,
      sideEffects: source.sideEffects,
      files: ["dist"],
      exports: expectedExportsFor(workspace),
      ...(source.dependencies === undefined ? {} : { dependencies: source.dependencies })
    }).pipe(Effect.mapError((cause) => failure(workspace, "stage", "publish package manifest could not be encoded", cause)))
    yield* fs.writeFileString(path.join(target, "package.json"), `${manifest}\n`).pipe(
      Effect.mapError((cause) => failure(workspace, "stage", "publish package manifest could not be written", cause))
    )
  }
)

export const PackageStagerLive = Layer.effect(PackageStager, Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return PackageStager.of({
    stage: Effect.fn("PackageCertification.stagePackage")((workspace, root, version) => {
      if (workspace === "@expand/contracts") {
        return stageContracts(root, version).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError((cause) => failure(workspace, "stage", "package staging failed", cause))
        )
      }
      if (workspace === "@expand/client-ts") {
        return stageClient(root, version).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError((cause) => failure(workspace, "stage", "package staging failed", cause))
        )
      }
      return stageBuiltLibrary(workspace, root, version).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path)
      )
    })
  })
}))

const mapCertificationError = (workspace: Workspace, phase: PackageCertificationError["phase"], detail: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.mapError((cause) => failure(workspace, phase, detail, cause)))

export const encodeCertificationJson = Effect.fn("PackageCertification.encodeJson")(
  (workspace: Workspace, phase: PackageCertificationError["phase"], detail: string, value: unknown) =>
    Schema.encodeEffect(Schema.UnknownFromJsonString)(value).pipe(mapCertificationError(workspace, phase, detail))
)

const sameValue = (actual: unknown, expected: unknown): boolean => {
  if (actual === expected) return true
  if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object") return false
  if (Array.isArray(actual) || Array.isArray(expected)) return false
  const actualRecord = actual as Readonly<Record<string, unknown>>
  const expectedRecord = expected as Readonly<Record<string, unknown>>
  const keys = Object.keys(actualRecord)
  const expectedKeys = Object.keys(expectedRecord)
  return keys.length === expectedKeys.length && expectedKeys.every((key) => sameValue(actualRecord[key], expectedRecord[key]))
}

const exportTargets = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value]
  if (value === null || typeof value !== "object" || Array.isArray(value)) return []
  return Object.values(value as Readonly<Record<string, unknown>>).flatMap(exportTargets)
}

const validateTarEntries = (workspace: Workspace, entries: ReadonlyArray<TarEntry>) => Effect.gen(function*() {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.type === "link") return yield* failure(workspace, "inspect", `link tar entry: ${entry.path}`)
    if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) {
      return yield* failure(workspace, "inspect", `traversal tar entry: ${entry.path}`)
    }
    if (seen.has(entry.path)) return yield* failure(workspace, "inspect", `duplicate tar entry: ${entry.path}`)
    seen.add(entry.path)
    if (entry.path === "package" || entry.path === "package/" || entry.path === "package/dist" || entry.path === "package/dist/") continue
    const packedPath = entry.path.startsWith("package/") ? entry.path.slice("package/".length) : ""
    if (packedPath !== "package.json" && !packedPath.startsWith("dist/")) {
      return yield* failure(workspace, "inspect", `unexpected packed path: ${entry.path}`)
    }
  }
})

const targetExists = (files: ReadonlyArray<string>, target: string): boolean => {
  const normalized = target.startsWith("./") ? target.slice(2) : target
  if (!normalized.includes("*")) return files.includes(normalized)
  const [prefix, suffix] = normalized.split("*")
  return prefix !== undefined && suffix !== undefined && files.some((file) => file.startsWith(prefix) && file.endsWith(suffix))
}

export interface ContractsWildcardTarget {
  readonly subpath: string
  readonly runtime: string
  readonly declaration: string
}

export const resolveContractsWildcardTargets = (files: ReadonlyArray<string>): ReadonlyArray<ContractsWildcardTarget> => {
  const runtimes = new Map<string, number>()
  const declarations = new Map<string, number>()
  for (const file of files) {
    if (file.startsWith("dist/") && file.endsWith(".d.ts")) {
      const stem = file.slice("dist/".length, -".d.ts".length)
      declarations.set(stem, (declarations.get(stem) ?? 0) + 1)
    } else if (file.startsWith("dist/") && file.endsWith(".js")) {
      const stem = file.slice("dist/".length, -".js".length)
      runtimes.set(stem, (runtimes.get(stem) ?? 0) + 1)
    }
  }
  const stems = [...new Set([...runtimes.keys(), ...declarations.keys()])].sort()
  return stems.flatMap((stem) => stem === "events/domain-event" ? [] : [{
    subpath: `@expand/contracts/${stem}`,
    runtime: `dist/${stem}.js`,
    declaration: `dist/${stem}.d.ts`
  }])
}

const validateContractsWildcardTargets = (files: ReadonlyArray<string>) => Effect.gen(function*() {
  const counts = new Map<string, number>()
  for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1)
  const duplicate = [...counts].find(([file, count]) => count > 1 && (file.endsWith(".js") || file.endsWith(".d.ts")))
  if (duplicate !== undefined) return yield* failure("@expand/contracts", "inspect", `duplicate wildcard target: ${duplicate[0]}`)
  const runtimes = new Set(files.filter((file) => file.startsWith("dist/") && file.endsWith(".js")).map((file) => file.slice(0, -3)))
  const declarations = new Set(files.filter((file) => file.startsWith("dist/") && file.endsWith(".d.ts")).map((file) => file.slice(0, -5)))
  const unmatched = [...new Set([...runtimes, ...declarations])].sort().find((stem) => !runtimes.has(stem) || !declarations.has(stem))
  if (unmatched !== undefined) return yield* failure("@expand/contracts", "inspect", `missing paired wildcard target: ${unmatched}`)
})

export const inspectPackageArtifact = Effect.fn("PackageCertification.inspectPackageArtifact")(
  function*(input: {
    readonly workspace: Workspace
    readonly unpackedRoot: string
    readonly filename: string
    readonly metadataFiles: ReadonlyArray<string>
    readonly tarEntries: ReadonlyArray<TarEntry>
  }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* validateTarEntries(input.workspace, input.tarEntries)
    for (const file of input.metadataFiles) {
      const segments = file.split("/")
      const leaked = segments.some((segment) => segment === "src" || segment === "test" || segment === "tests") ||
        /(?:^|\.)test\.[^/]+$/.test(file) || /(?:^|\/)(?:tsconfig|vitest\.config|eslint\.config)[^/]*$/.test(file)
      if ((file !== "package.json" && !file.startsWith("dist/")) || leaked) {
        return yield* failure(input.workspace, "inspect", `unexpected packed path: ${file}`)
      }
    }
    const manifestSource = yield* fs.readFileString(path.join(input.unpackedRoot, "package.json")).pipe(
      Effect.mapError((cause) => failure(input.workspace, "inspect", "package.json could not be read", cause))
    )
    const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PublishedManifest))(manifestSource).pipe(
      Effect.mapError((cause) => failure(input.workspace, "inspect", "package.json was malformed", cause))
    )
    if (manifest.private !== false) return yield* failure(input.workspace, "inspect", "private must be false")
    if (manifest.files.length !== 1 || manifest.files[0] !== "dist") {
      return yield* failure(input.workspace, "inspect", "files must equal [\"dist\"]")
    }
    if (manifest.name !== input.workspace) return yield* failure(input.workspace, "inspect", "package name did not match workspace")
    const expectedExports = expectedExportsFor(input.workspace)
    if (!sameValue(manifest.exports, expectedExports)) return yield* failure(input.workspace, "inspect", "wrong export surface")
    for (const target of exportTargets(manifest.exports)) {
      if (!targetExists(input.metadataFiles, target)) return yield* failure(input.workspace, "inspect", `missing export target: ${target}`)
    }
    if (input.workspace === "@expand/contracts") yield* validateContractsWildcardTargets(input.metadataFiles)
    return {
      workspace: input.workspace,
      packageName: manifest.name,
      filename: input.filename,
      files: input.metadataFiles,
      exports: manifest.exports,
      version: manifest.version,
      dependencies: manifest.dependencies ?? {}
    } satisfies PackageCertificationReport
  }
)

export const PackageCertificationCommandRunnerLive = Layer.effect(
  PackageCertificationCommandRunner,
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return PackageCertificationCommandRunner.of({
      run: Effect.fn("PackageCertification.command")((request) => Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawner.spawn(ChildProcess.make(request.command, request.args, { cwd: request.cwd })).pipe(
          Effect.mapError((cause) => failure(request.workspace, request.phase, `${request.command} could not start`, cause))
        )
        const [stdout, stderr, exitCode] = yield* Effect.all([
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode
        ], { concurrency: "unbounded" }).pipe(
          Effect.mapError((cause) => failure(request.workspace, request.phase, `${request.command} failed`, cause))
        )
        return { stdout, stderr, exitCode: Number(exitCode) }
      })))
    })
  })
)

const run = Effect.fn("PackageCertification.runCommand")((request: PackageCertificationCommandRequest) => Effect.gen(function*() {
  const runner = yield* PackageCertificationCommandRunner
  const result = yield* runner.run(request)
  if (result.exitCode !== 0) {
    const output = [result.stdout.trim(), result.stderr.trim()].filter((value) => value.length > 0).join("\n")
    return yield* failure(request.workspace, request.phase, `${request.command} exited ${result.exitCode}: ${output}`)
  }
  return result
}))

const parseTarEntries = (workspace: Workspace, paths: string, verbose: string) => Effect.gen(function*() {
  const pathRows = paths.split("\n").filter((row) => row.length > 0)
  const verboseRows = verbose.split("\n").filter((row) => row.length > 0)
  if (pathRows.length !== verboseRows.length) return yield* failure(workspace, "inspect", "tar listing was inconsistent")
  return pathRows.map((path, index): TarEntry => ({
    path,
    type: verboseRows[index]!.startsWith("l") || verboseRows[index]!.startsWith("h") ? "link"
      : verboseRows[index]!.startsWith("d") ? "directory" : "file"
  }))
})

const stagePaths = (root: string, directory: string, path: Path.Path) => [
  path.join(root, directory, "dist-publish"),
  path.join(root, directory, ".dist-publish.next"),
  path.join(root, directory, ".dist-publish.previous")
]

const retainCleanup = <A, E, R, E2, R2>(program: Effect.Effect<A, E, R>, cleanup: Effect.Effect<void, E2, R2>) =>
  Effect.uninterruptibleMask((restore) => Effect.exit(restore(program)).pipe(Effect.flatMap((primary) => Effect.exit(cleanup).pipe(Effect.flatMap((released) => {
    if (Exit.isFailure(primary)) return Exit.isFailure(released)
      ? Effect.failCause(Cause.combine(primary.cause, released.cause))
      : Effect.failCause(primary.cause)
    return Exit.isFailure(released) ? Effect.failCause(released.cause) : Effect.succeed(primary.value)
  })))))

const cleanupStage = (root: string, directory: string, workspace: Workspace) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const removals = stagePaths(root, directory, path).map((target) => Effect.gen(function*() {
    const removed = yield* fs.remove(target, { recursive: true, force: true }).pipe(
      Effect.mapError((cause) => failure(workspace, "inspect", "staging cleanup failed", cause))
    )
    return removed
  }))
  return yield* retainCleanup(removals[0]!, retainCleanup(removals[1]!, removals[2]!))
})

const runWorkspaceLifecycle = <A, E, R>(
  root: string,
  directory: string,
  workspace: Workspace,
  program: Effect.Effect<A, E, R>
) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const paths = stagePaths(root, directory, path)
  const existing = yield* Effect.filter(paths, (target) => fs.exists(target)).pipe(
    mapCertificationError(workspace, "stage", "staging paths could not be checked")
  )
  if (existing.length > 0) return yield* failure(workspace, "stage", `staging path already exists: ${existing[0]}`)
  return yield* retainCleanup(program, cleanupStage(root, directory, workspace))
})

const smokeTargets = (workspace: Workspace, files: ReadonlyArray<string>) => {
  if (workspace === "@expand/contracts") {
    const targets = resolveContractsWildcardTargets(files).map((target) => target.subpath)
    return { runtime: targets, types: targets }
  }
  if (workspace === "@expand/client-ts") {
    const targets = ["@expand/client-ts", "@expand/client-ts/project", "@expand/client-ts/server", "@expand/client-ts/adapters/node"]
    return { runtime: targets, types: targets }
  }
  if (workspace === "@expand/electron-ipc") {
    return {
      runtime: ["@expand/electron-ipc/contract", "@expand/electron-ipc/renderer"],
      types: ["@expand/electron-ipc/contract", "@expand/electron-ipc/main", "@expand/electron-ipc/preload", "@expand/electron-ipc/renderer"]
    }
  }
  const targets = ["@expand/ink-input"]
  return { runtime: targets, types: targets }
}

export const certifyPackages = Effect.fn("PackageCertification.run")(
  (root: string) => Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const stager = yield* PackageStager
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "expand-package-certification-" }).pipe(
      mapCertificationError("@expand/contracts", "build", "temporary directory could not be created")
    )
    const reports: Array<PackageCertificationReport> = []
    const tarballs: Array<string> = []
    for (const workspace of workspaces) {
      const work = Effect.gen(function*() {
        yield* (workspace.build === "workspace"
          ? run({ workspace: workspace.name, phase: "build", command: "npm", args: ["run", "build", "--workspace", workspace.name], cwd: root })
          : run({
            workspace: workspace.name,
            phase: "build",
            command: path.join(root, "node_modules", ".bin", "tsup"),
            args: workspace.build,
            cwd: path.join(root, workspace.directory)
          }))
        yield* stager.stage(workspace.name, path.join(root, workspace.directory), "0.0.0-cert.0")
        const packed = yield* run({
          workspace: workspace.name,
          phase: "pack",
          command: "npm",
          args: ["pack", `${workspace.directory}/dist-publish`, "--json", "--pack-destination", temp],
          cwd: root
        })
        const metadataRows = yield* Schema.decodeUnknownEffect(PackMetadataJson)(packed.stdout).pipe(
          Effect.mapError((cause) => failure(workspace.name, "pack", "npm pack returned malformed JSON", cause))
        )
        if (metadataRows.length !== 1) return yield* failure(workspace.name, "pack", "npm pack returned an unexpected report count")
        const metadata = metadataRows[0]!
        const tarball = path.join(temp, metadata.filename)
        tarballs.push(tarball)
        const listed = yield* run({ workspace: workspace.name, phase: "inspect", command: "tar", args: ["-tzf", tarball], cwd: root })
        const verbose = yield* run({ workspace: workspace.name, phase: "inspect", command: "tar", args: ["-tvzf", tarball], cwd: root })
        const tarEntries = yield* parseTarEntries(workspace.name, listed.stdout, verbose.stdout)
        yield* validateTarEntries(workspace.name, tarEntries)
        const unpacked = path.join(temp, workspace.name.slice("@expand/".length))
        yield* fs.makeDirectory(unpacked, { recursive: true }).pipe(
          Effect.mapError((cause) => failure(workspace.name, "inspect", "unpack directory could not be created", cause))
        )
        yield* run({ workspace: workspace.name, phase: "inspect", command: "tar", args: ["-xzf", tarball, "--no-same-owner", "--no-same-permissions", "-C", unpacked], cwd: root })
        const report = yield* inspectPackageArtifact({
          workspace: workspace.name,
          unpackedRoot: path.join(unpacked, "package"),
          filename: metadata.filename,
          metadataFiles: metadata.files.map((file) => file.path),
          tarEntries
        })
        reports.push(report)
      })
      yield* runWorkspaceLifecycle(root, workspace.directory, workspace.name, work)
    }
    const contracts = reports.find((report) => report.workspace === "@expand/contracts")
    const client = reports.find((report) => report.workspace === "@expand/client-ts")
    if (
      reports.length !== workspaces.length ||
      contracts === undefined ||
      client === undefined ||
      reports.some((report) => report.version !== contracts.version) ||
      client.dependencies["@expand/contracts"] !== contracts.version
    ) {
      return yield* failure("@expand/client-ts", "inspect", "fixed-group package versions were not aligned")
    }
    const consumer = path.join(temp, "consumer")
    yield* fs.makeDirectory(consumer, { recursive: true }).pipe(
      Effect.mapError((cause) => failure("@expand/client-ts", "inspect", "consumer directory could not be created", cause))
    )
    const consumerManifest = yield* encodeCertificationJson(
      "@expand/client-ts",
      "inspect",
      "consumer manifest could not be encoded",
      { private: true, type: "module" }
    )
    yield* fs.writeFileString(path.join(consumer, "package.json"), consumerManifest).pipe(
      mapCertificationError("@expand/client-ts", "inspect", "consumer manifest could not be written")
    )
    yield* run({
      workspace: "@expand/client-ts",
      phase: "inspect",
      command: "npm",
      args: ["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", ...tarballs],
      cwd: consumer
    })
    const targets = reports.map((report) => smokeTargets(report.workspace, report.files))
    const runtimeTargets = yield* Effect.forEach(targets.flatMap(({ runtime }) => runtime), (target) => encodeCertificationJson(
      "@expand/client-ts",
      "inspect",
      "smoke target could not be encoded",
      target
    ))
    const importSource = `${runtimeTargets.map((target) => `import ${target}`).join("\n")}\n`
    yield* fs.writeFileString(path.join(consumer, "smoke.mjs"), importSource).pipe(
      Effect.mapError((cause) => failure("@expand/client-ts", "inspect", "import smoke could not be written", cause))
    )
    yield* run({ workspace: "@expand/client-ts", phase: "inspect", command: "node", args: ["smoke.mjs"], cwd: consumer })
    const typeTargets = yield* Effect.forEach(targets.flatMap(({ types }) => types), (target) => encodeCertificationJson(
      "@expand/client-ts",
      "inspect",
      "type smoke target could not be encoded",
      target
    ))
    const typeSource = `${typeTargets.map((target, index) => `import type * as T${index} from ${target}\ntype V${index} = typeof T${index}`).join("\n")}\n`
    yield* fs.writeFileString(path.join(consumer, "smoke.ts"), typeSource).pipe(
      mapCertificationError("@expand/client-ts", "inspect", "type smoke could not be written")
    )
    const typeScriptConfig = yield* encodeCertificationJson(
      "@expand/client-ts",
      "inspect",
      "TypeScript configuration could not be encoded",
      {
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022" },
        files: ["smoke.ts"]
      }
    )
    yield* fs.writeFileString(path.join(consumer, "tsconfig.json"), typeScriptConfig).pipe(
      mapCertificationError("@expand/client-ts", "inspect", "TypeScript configuration could not be written")
    )
    yield* run({ workspace: "@expand/client-ts", phase: "inspect", command: path.join(root, "node_modules", ".bin", "tsc"), args: ["-p", "tsconfig.json"], cwd: consumer })
    return reports
  }))
)

const program = Path.Path.pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../", import.meta.url))),
  Effect.flatMap(certifyPackages),
  Effect.provide(Layer.merge(PackageStagerLive, PackageCertificationCommandRunnerLive).pipe(Layer.provideMerge(NodeServices.layer)))
)

if (import.meta.main) {
  NodeRuntime.runMain(program)
}
