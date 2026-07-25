import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  certifyPackages,
  inspectPackageArtifact,
  PackageCertificationCommandRunner,
  PackageCertificationError,
  PackMetadataJson
} from "./package-certification"

const clientExports = {
  ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
  "./project": { types: "./dist/project/index.d.ts", import: "./dist/project/index.js", default: "./dist/project/index.js" },
  "./server": { types: "./dist/server/index.d.ts", import: "./dist/server/index.js", default: "./dist/server/index.js" },
  "./adapters/node": { types: "./dist/adapters/node.d.ts", import: "./dist/adapters/node.js", default: "./dist/adapters/node.js" },
  "./package.json": "./package.json"
}

const contractsExports = {
  "./events/domain-event": null,
  "./package.json": "./package.json",
  "./*": { types: "./dist/*.d.ts", import: "./dist/*.js", default: "./dist/*.js" }
}

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
      exports: kind === "contracts" ? contractsExports : clientExports
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
  it.effect("reports a nonzero child exit with its phase", () => {
    const layer = Layer.succeed(PackageCertificationCommandRunner, PackageCertificationCommandRunner.of({
      run: (request) => Effect.succeed({ exitCode: request.phase === "build" ? 9 : 0, stdout: "", stderr: "failed" })
    }))
    return certifyPackages("/fixture").pipe(
      Effect.provide(layer),
      Effect.provide(NodeServices.layer),
      Effect.flip,
      Effect.map((error) => expect(error).toMatchObject({ workspace: "@expand/contracts", phase: "build", detail: expect.stringContaining("exited 9") }))
    )
  })

  it.effect("removes scoped temporary state when interrupted", () => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const created = yield* Deferred.make<string>()
    const fileSystem = FileSystem.make({
      ...fs,
      makeTempDirectoryScoped: (options) => fs.makeTempDirectoryScoped(options).pipe(Effect.tap((value) => Deferred.succeed(created, value)))
    })
    const layer = Layer.succeed(PackageCertificationCommandRunner, PackageCertificationCommandRunner.of({
      run: () => Effect.never
    }))
    const fiber = yield* certifyPackages("/fixture").pipe(
      Effect.provide(layer),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.forkChild({ startImmediately: true })
    )
    const temp = yield* Deferred.await(created)
    yield* Fiber.interrupt(fiber)
    expect(yield* fs.exists(temp)).toBe(false)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
