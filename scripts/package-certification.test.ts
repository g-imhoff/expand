import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Ref, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  certifyPackages,
  encodeCertificationJson,
  inspectPackageArtifact,
  PackageCertificationCommandRunner,
  PackageCertificationError,
  PackMetadataJson,
  resolveContractsWildcardTargets
} from "./package-certification"

const clientExports = () => ({
  ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
  "./project": { types: "./dist/project/index.d.ts", import: "./dist/project/index.js", default: "./dist/project/index.js" },
  "./server": { types: "./dist/server/index.d.ts", import: "./dist/server/index.js", default: "./dist/server/index.js" },
  "./adapters/node": { types: "./dist/adapters/node.d.ts", import: "./dist/adapters/node.js", default: "./dist/adapters/node.js" },
  "./package.json": "./package.json"
})

const contractsExports = () => ({
  "./events/domain-event": null,
  "./package.json": "./package.json",
  "./*": { types: "./dist/*.d.ts", import: "./dist/*.js", default: "./dist/*.js" }
})

const filesFor = (kind: "contracts" | "client") => kind === "contracts"
  ? ["package.json", "dist/process-control.js", "dist/process-control.d.ts"]
  : [
      "package.json",
      "dist/index.js", "dist/index.d.ts",
      "dist/project/index.js", "dist/project/index.d.ts",
      "dist/server/index.js", "dist/server/index.d.ts",
      "dist/adapters/node.js", "dist/adapters/node.d.ts"
    ]

const withArtifact = Effect.fn("PackageCertificationTest.withArtifact")(
  function* <A>(
    kind: "contracts" | "client",
    mutate: (manifest: Record<string, unknown>, files: Array<string>) => void,
    use: (input: { readonly root: string; readonly files: ReadonlyArray<string> }) => Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>
  ) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-package-artifact-" })
    const files = filesFor(kind)
    const manifest: Record<string, unknown> = {
      name: kind === "contracts" ? "@expand/contracts" : "@expand/client-ts",
      version: "0.0.0",
      private: false,
      type: "module",
      files: ["dist"],
      exports: kind === "contracts" ? contractsExports() : clientExports()
    }
    mutate(manifest, files)
    for (const file of files) {
      const target = path.join(root, file)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, file === "package.json"
        ? yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(manifest)
        : file.endsWith(".d.ts") ? "export declare const value: number\n" : "export const value = 1\n")
    }
    return yield* use({ root, files })
  }
)

const artifact = <A>(
  kind: "contracts" | "client",
  mutate: (manifest: Record<string, unknown>, files: Array<string>) => void,
  use: Parameters<typeof withArtifact<A>>[2]
) => withArtifact(kind, mutate, use).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const inspect = (kind: "contracts" | "client", mutate: (manifest: Record<string, unknown>, files: Array<string>) => void = () => {}) =>
  artifact(kind, mutate, ({ root, files }) => inspectPackageArtifact({
    workspace: kind === "contracts" ? "@expand/contracts" : "@expand/client-ts",
    unpackedRoot: root,
    filename: `${kind}-0.0.0.tgz`,
    metadataFiles: files,
    tarEntries: files.map((path) => ({ path: `package/${path}`, type: "file" as const }))
  }))

const expectInspectFailure = (effect: Effect.Effect<unknown, PackageCertificationError, never>, detail: string) =>
  effect.pipe(Effect.flip, Effect.map((error) => expect(error).toMatchObject({ phase: "inspect", detail: expect.stringContaining(detail) })))

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
  : false
type Assert<T extends true> = T
type CertifyPackagesErrorIsExact = Assert<Equal<Effect.Error<ReturnType<typeof certifyPackages>>, PackageCertificationError>>
const certifyPackagesErrorIsExact: CertifyPackagesErrorIsExact = true

const certificationRunner = Layer.succeed(PackageCertificationCommandRunner, PackageCertificationCommandRunner.of({
  run: (request) => {
    const kind = request.workspace === "@expand/contracts" ? "contracts" : "client"
    const files = filesFor(kind)
    if (request.phase === "pack") {
      return Schema.encodeEffect(Schema.UnknownFromJsonString)([{
        id: `${kind}@0.0.0`, name: request.workspace, version: "0.0.0", size: 1, unpackedSize: 1,
        shasum: "x", integrity: "x", filename: `${kind}.tgz`, files: files.map((file) => ({ path: file, size: 1, mode: 420 })),
        entryCount: files.length, bundled: []
      }]).pipe(Effect.map((stdout) => ({ exitCode: 0, stdout, stderr: "" })), Effect.orDie)
    }
    if (request.command === "tar" && request.args[0] === "-tzf") {
      return Effect.succeed({ exitCode: 0, stdout: files.map((file) => `package/${file}`).join("\n"), stderr: "" })
    }
    if (request.command === "tar" && request.args[0] === "-tvzf") {
      return Effect.succeed({ exitCode: 0, stdout: files.map((file) => `-rw-r--r-- user/group 1 date package/${file}`).join("\n"), stderr: "" })
    }
    return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
  }
}))

const manifestJson = (workspace: "@expand/contracts" | "@expand/client-ts") => Schema.encodeEffect(Schema.UnknownFromJsonString)({
  name: workspace,
  version: "0.0.0",
  private: false,
  type: "module",
  files: ["dist"],
  exports: workspace === "@expand/contracts" ? contractsExports() : clientExports()
}).pipe(Effect.orDie)

describe("package certification model", () => {
  it.effect.each(["contracts", "client"] as const)("accepts a valid synthetic %s package", (kind) =>
    inspect(kind).pipe(Effect.map((report) => expect(report.packageName).toBe(`@expand/${kind === "client" ? "client-ts" : "contracts"}`))))

  it.effect("rejects malformed npm pack JSON", () =>
    Schema.decodeUnknownEffect(PackMetadataJson)("not json").pipe(
      Effect.flip,
      Effect.map((error) => expect(String(error)).toContain("Unexpected token"))
    ))

  it.effect.each([
    ["source", "src/private.ts"],
    ["test", "dist/index.test.js"],
    ["config", "tsconfig.json"]
  ] as const)("rejects a leaked %s file", ([, leaked]) =>
    inspect("client", (_manifest, files) => files.push(leaked)).pipe(Effect.flip, Effect.map((error) => {
      expect(error).toMatchObject({ detail: expect.stringContaining("unexpected packed path") })
    })))

  it.effect("rejects a missing export target", () =>
    inspect("client", (_manifest, files) => files.splice(files.indexOf("dist/project/index.js"), 1)).pipe(
      Effect.flip,
      Effect.map((error) => expect(error).toMatchObject({ detail: expect.stringContaining("missing export target") }))
    ))

  it.effect.each([
    ["JavaScript-only", ["dist/extra.js"]],
    ["type-only", ["dist/extra.d.ts"]],
    ["unmatched stems", ["dist/runtime.js", "dist/declaration.d.ts"]]
  ] as const)("rejects contracts wildcard %s targets", ([, additions]) =>
    inspect("contracts", (_manifest, files) => files.push(...additions)).pipe(
      Effect.flip,
      Effect.map((error) => expect(error).toMatchObject({ detail: expect.stringContaining("paired wildcard target") }))
    ))

  it.effect("rejects duplicate contracts wildcard mappings", () =>
    artifact("contracts", (_manifest, files) => files.push("dist/process-control.js"), ({ root, files }) => inspectPackageArtifact({
      workspace: "@expand/contracts",
      unpackedRoot: root,
      filename: "contracts.tgz",
      metadataFiles: files,
      tarEntries: [...new Set(files)].map((path) => ({ path: `package/${path}`, type: "file" as const }))
    })).pipe(
      Effect.flip,
      Effect.map((error) => expect(error).toMatchObject({ detail: expect.stringContaining("duplicate wildcard target") }))
    ))

  it.effect("expands every paired non-null contracts wildcard target deterministically", () => Effect.sync(() => {
    const targets = resolveContractsWildcardTargets([
      "package.json",
      "dist/zeta.js",
      "dist/events/domain-event.d.ts",
      "dist/nested/module.d.ts",
      "dist/zeta.d.ts",
      "dist/events/domain-event.js",
      "dist/nested/module.js"
    ])
    expect(targets).toEqual([
      { subpath: "@expand/contracts/nested/module", runtime: "dist/nested/module.js", declaration: "dist/nested/module.d.ts" },
      { subpath: "@expand/contracts/zeta", runtime: "dist/zeta.js", declaration: "dist/zeta.d.ts" }
    ])
  }))

  it.effect.each([
    ["private", (manifest: Record<string, unknown>) => { manifest.private = true }],
    ["files", (manifest: Record<string, unknown>) => { manifest.files = ["dist", "src"] }]
  ] as const)("rejects the wrong %s field", ([field, mutate]) =>
    inspect("contracts", mutate).pipe(Effect.flip, Effect.map((error) => expect(error).toMatchObject({ detail: expect.stringContaining(field) }))))

  it.effect.each([
    ["duplicate", [{ path: "package/package.json", type: "file" as const }, { path: "package/package.json", type: "file" as const }]],
    ["traversal", [{ path: "package/../secret", type: "file" as const }]],
    ["link", [{ path: "package/dist/index.js", type: "link" as const }]]
  ] as const)("rejects a %s tar entry", ([kind, entries]) =>
    artifact("client", () => {}, ({ root, files }) => inspectPackageArtifact({
      workspace: "@expand/client-ts",
      unpackedRoot: root,
      filename: "client.tgz",
      metadataFiles: files,
      tarEntries: entries
    })).pipe(Effect.flip, Effect.map((error) => expect(error).toMatchObject({ detail: expect.stringContaining(kind) }))))

  it.effect("rejects the wrong client export surface", () =>
    inspect("client", (manifest) => { (manifest.exports as Record<string, unknown>)["./private"] = "./dist/private.js" }).pipe(
      Effect.flip,
      Effect.map((error) => expect(error).toMatchObject({ detail: expect.stringContaining("export surface") }))
    ))

  it.effect.each(["contracts", "client"] as const)("rejects wrong %s export target mappings", (kind) =>
    inspect(kind, (manifest) => {
      const exports = manifest.exports as Record<string, unknown>
      if (kind === "contracts") {
        exports["./*"] = { types: "./dist/*.d.ts", import: "./dist/*.js", default: "./dist/*.d.ts" }
      } else {
        exports["./project"] = { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" }
      }
    }).pipe(
      Effect.flip,
      Effect.map((error) => expect(error).toMatchObject({ detail: expect.stringContaining("export surface") }))
    ))
})

describe("package certification resources", () => {
  it("exposes exactly PackageCertificationError", () => {
    expect(certifyPackagesErrorIsExact).toBe(true)
  })

  it.effect.each([
    ["temporary directory acquisition", "@expand/contracts", "build", "temporary directory could not be created", (failure: unknown) => FileSystem.layerNoop({ makeTempDirectoryScoped: () => Effect.fail(failure as never) })],
    ["staging existence", "@expand/contracts", "stage", "staging paths could not be checked", (failure: unknown) => FileSystem.layerNoop({ makeTempDirectoryScoped: () => Effect.succeed("/tmp/cert"), exists: () => Effect.fail(failure as never) })],
    ["manifest read", "@expand/contracts", "inspect", "package.json could not be read", (failure: unknown) => FileSystem.layerNoop({ makeTempDirectoryScoped: () => Effect.succeed("/tmp/cert"), exists: () => Effect.succeed(false), makeDirectory: () => Effect.void, remove: () => Effect.void, readFileString: () => Effect.fail(failure as never) })],
    ["consumer manifest write", "@expand/client-ts", "inspect", "consumer manifest could not be written", (failure: unknown) => FileSystem.layerNoop({ makeTempDirectoryScoped: () => Effect.succeed("/tmp/cert"), exists: () => Effect.succeed(false), makeDirectory: () => Effect.void, remove: () => Effect.void, readFileString: (target) => manifestJson(target.includes("contracts") ? "@expand/contracts" : "@expand/client-ts"), writeFileString: () => Effect.fail(failure as never) })],
    ["import smoke write", "@expand/client-ts", "inspect", "import smoke could not be written", (failure: unknown) => FileSystem.layerNoop({ makeTempDirectoryScoped: () => Effect.succeed("/tmp/cert"), exists: () => Effect.succeed(false), makeDirectory: () => Effect.void, remove: () => Effect.void, readFileString: (target) => manifestJson(target.includes("contracts") ? "@expand/contracts" : "@expand/client-ts"), writeFileString: (target) => target.endsWith("smoke.mjs") ? Effect.fail(failure as never) : Effect.void })]
  ] as const)("maps %s failures at the operation boundary", ([, workspace, phase, detail, fileSystem]) => {
    const cause = { operation: detail }
    return certifyPackages("/fixture").pipe(
      Effect.provide(Layer.mergeAll(certificationRunner, fileSystem(cause), Path.layer)),
      Effect.flip,
      Effect.map((error) => expect(error).toEqual(new PackageCertificationError({ workspace, phase, detail, cause })))
    )
  })

  it.effect("maps Schema encode failures at the operation boundary", () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    return encodeCertificationJson("@expand/client-ts", "inspect", "smoke source could not be encoded", cyclic).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(PackageCertificationError)
        expect(error).toMatchObject({ workspace: "@expand/client-ts", phase: "inspect", detail: "smoke source could not be encoded" })
        expect(error.cause).toBeDefined()
      })
    )
  })

  it.effect.each([
    ["defect", Effect.die("temporary directory defect"), false],
    ["interruption", Effect.interrupt, true]
  ] as const)("preserves temporary directory %s as Cause information", ([, acquisition, interrupted]) => certifyPackages("/fixture").pipe(
    Effect.provide(Layer.mergeAll(certificationRunner, FileSystem.layerNoop({ makeTempDirectoryScoped: () => acquisition }), Path.layer)),
    Effect.exit,
    Effect.map((exit) => {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(Cause.hasInterrupts(exit.cause)).toBe(interrupted)
      expect(Cause.hasFails(exit.cause)).toBe(false)
    })
  ))

  it.effect("reports a nonzero child exit with its phase", () => {
    const layer = Layer.succeed(PackageCertificationCommandRunner, PackageCertificationCommandRunner.of({
      run: (request) => Effect.succeed({ exitCode: request.phase === "build" ? 9 : 0, stdout: "", stderr: "failed" })
    }))
    return certifyPackages("/fixture").pipe(
      Effect.provide(Layer.mergeAll(layer, NodeServices.layer)),
      Effect.flip,
      Effect.map((error) => expect(error).toMatchObject({ workspace: "@expand/contracts", phase: "build", detail: expect.stringContaining("exited 9") }))
    )
  })

  it.effect.each([
    ["@expand/contracts", "pack"],
    ["@expand/contracts", "inspect"],
    ["@expand/client-ts", "pack"],
    ["@expand/client-ts", "inspect"]
  ] as const)("removes real owned staging, archive, and temporary residue exactly once when %s is interrupted during %s", ([interruptedWorkspace, interruptedPhase]) => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-package-interruption-" })
    const tempCreated = yield* Deferred.make<string>()
    const archiveCreated = yield* Deferred.make<string>()
    const phaseStarted = yield* Deferred.make<void>()
    const removals = yield* Ref.make<ReadonlyArray<string>>([])
    const stagingNames = ["dist-publish", ".dist-publish.next", ".dist-publish.previous"] as const
    const workspaceRoot = (workspace: "@expand/contracts" | "@expand/client-ts") => path.join(root, workspace === "@expand/contracts" ? "packages/contracts" : "packages/client-ts")
    const unowned = path.join(workspaceRoot(interruptedWorkspace), "unowned-residue")
    yield* fs.makeDirectory(unowned, { recursive: true })
    yield* fs.writeFileString(path.join(unowned, "keep"), "keep")
    const fileSystem = FileSystem.make({
      ...fs,
      makeTempDirectoryScoped: (options) => fs.makeTempDirectoryScoped(options).pipe(Effect.tap((value) => Deferred.succeed(tempCreated, value))),
      remove: (target, options) => Ref.update(removals, (values) => [...values, target]).pipe(Effect.andThen(fs.remove(target, options)))
    })
    const layer = Layer.succeed(PackageCertificationCommandRunner, PackageCertificationCommandRunner.of({
      run: (request) => Effect.gen(function*() {
        const kind = request.workspace === "@expand/contracts" ? "contracts" : "client"
        const files = filesFor(kind)
        if (request.phase === "stage") {
          for (const name of stagingNames) {
            const target = path.join(workspaceRoot(request.workspace), name)
            yield* fs.makeDirectory(target, { recursive: true })
            yield* fs.writeFileString(path.join(target, "residue"), name)
          }
        }
        if (request.phase === "pack") {
          const destination = request.args[request.args.indexOf("--pack-destination") + 1]!
          const archive = path.join(destination, `${kind}.tgz`)
          yield* fs.writeFileString(archive, "partial tar archive")
          if (request.workspace === interruptedWorkspace) yield* Deferred.succeed(archiveCreated, archive)
          if (request.workspace === interruptedWorkspace && request.phase === interruptedPhase) {
            yield* Deferred.succeed(phaseStarted, undefined)
            return yield* Effect.never
          }
          return { exitCode: 0, stdout: yield* Schema.encodeEffect(Schema.UnknownFromJsonString)([{
            id: `${kind}@0.0.0`, name: request.workspace, version: "0.0.0", size: 1, unpackedSize: 1,
            shasum: "x", integrity: "x", filename: `${kind}.tgz`, files: files.map((file) => ({ path: file, size: 1, mode: 420 })),
            entryCount: files.length, bundled: []
          }]), stderr: "" }
        }
        if (request.workspace === interruptedWorkspace && request.phase === interruptedPhase) {
          yield* Deferred.succeed(phaseStarted, undefined)
          return yield* Effect.never
        }
        if (request.command === "tar" && request.args[0] === "-tzf") {
          return { exitCode: 0, stdout: files.map((file) => `package/${file}`).join("\n"), stderr: "" }
        }
        if (request.command === "tar" && request.args[0] === "-tvzf") {
          return { exitCode: 0, stdout: files.map((file) => `-rw-r--r-- user/group 1 date package/${file}`).join("\n"), stderr: "" }
        }
        if (request.command === "tar" && request.args[0] === "-xzf") {
          const destination = request.args[request.args.indexOf("-C") + 1]!
          const manifest = {
            name: request.workspace,
            version: "0.0.0",
            private: false,
            type: "module",
            files: ["dist"],
            exports: kind === "contracts" ? contractsExports() : clientExports()
          }
          for (const file of files) {
            const target = path.join(destination, "package", file)
            yield* fs.makeDirectory(path.dirname(target), { recursive: true })
            const content = file === "package.json"
              ? yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(manifest)
              : file.endsWith(".d.ts") ? "export declare const value: number\n" : "export const value = 1\n"
            yield* fs.writeFileString(target, content)
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" }
      }).pipe(Effect.orDie)
    }))
    const fiber = yield* certifyPackages(root).pipe(
      Effect.provide(layer),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.forkChild({ startImmediately: true })
    )
    const temp = yield* Deferred.await(tempCreated)
    const archive = yield* Effect.raceFirst(
      Deferred.await(archiveCreated),
      Fiber.await(fiber).pipe(Effect.map((exit) => Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "completed"))
    )
    expect(archive).toBe(path.join(temp, `${interruptedWorkspace === "@expand/contracts" ? "contracts" : "client"}.tgz`))
    expect(yield* fs.exists(archive)).toBe(true)
    const readiness = yield* Effect.raceFirst(
      Deferred.await(phaseStarted).pipe(Effect.as("started")),
      Fiber.await(fiber).pipe(Effect.map((exit) => Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "completed"))
    )
    expect(readiness).toBe("started")
    yield* Fiber.interrupt(fiber)
    yield* Fiber.await(fiber)
    const interruptedRoot = workspaceRoot(interruptedWorkspace)
    expect(yield* fs.exists(archive)).toBe(false)
    expect(yield* fs.exists(temp)).toBe(false)
    for (const name of stagingNames) expect(yield* fs.exists(path.join(interruptedRoot, name))).toBe(false)
    expect(yield* fs.exists(path.join(unowned, "keep"))).toBe(true)
    const removed = yield* Ref.get(removals)
    expect(removed).not.toContain(unowned)
    for (const name of stagingNames) expect(removed.filter((target) => target === path.join(interruptedRoot, name))).toHaveLength(1)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("preserves pre-existing staging paths that certification does not own", () => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-package-preexisting-" })
    const existing = path.join(root, "packages/contracts/dist-publish")
    yield* fs.makeDirectory(existing, { recursive: true })
    yield* fs.writeFileString(path.join(existing, "owned-elsewhere"), "keep")
    const layer = Layer.succeed(PackageCertificationCommandRunner, PackageCertificationCommandRunner.of({
      run: () => Effect.die("command must not run")
    }))
    const exit = yield* certifyPackages(root).pipe(Effect.provide(layer), Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* fs.exists(path.join(existing, "owned-elsewhere"))).toBe(true)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("retains interruption and cleanup failure Causes while cleaning real residue once", () => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-package-cleanup-cause-" })
    const phaseStarted = yield* Deferred.make<void>()
    const removals = yield* Ref.make(0)
    const target = path.join(root, "packages/contracts/dist-publish")
    const cleanupDefect = new Error("cleanup defect")
    const cleanupFailurePath = path.join(root, "packages/contracts/.dist-publish.next")
    const fileSystem = FileSystem.make({
      ...fs,
      remove: (candidate, options) => candidate === target
        ? Ref.update(removals, (count) => count + 1).pipe(Effect.andThen(fs.remove(candidate, options)))
        : candidate === cleanupFailurePath
          ? Effect.gen(function*() {
            const result = yield* Effect.die(cleanupDefect)
            return result
          })
          : fs.remove(candidate, options)
    })
    const layer = Layer.succeed(PackageCertificationCommandRunner, PackageCertificationCommandRunner.of({
      run: (request) => request.phase === "stage"
        ? fs.makeDirectory(target, { recursive: true }).pipe(Effect.as({ exitCode: 0, stdout: "", stderr: "" }), Effect.orDie)
        : request.phase === "pack"
          ? Deferred.succeed(phaseStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
    }))
    const fiber = yield* certifyPackages(root).pipe(
      Effect.provide(layer),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.forkChild({ startImmediately: true })
    )
    yield* Deferred.await(phaseStarted)
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(yield* fs.exists(target)).toBe(false)
    expect(yield* Ref.get(removals)).toBe(1)
    expect(Cause.pretty(exit.cause)).toContain("cleanup defect")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
