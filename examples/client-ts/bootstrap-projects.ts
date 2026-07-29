import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Layer, Console, Data, Effect, FileSystem, Path, Stdio } from "effect"
import { ProjectClient } from "@expand/client-ts/project"
import { adapter } from "./adapter"
import { clientLayer } from "./client-layer"

export class BootstrapInvalidInputError extends Data.TaggedError("BootstrapInvalidInputError")<{
  readonly root: string
}> {}

export class BootstrapReadError extends Data.TaggedError("BootstrapReadError")<{
  readonly root: string
  readonly cause: unknown
}> {}

export class BootstrapStatError extends Data.TaggedError("BootstrapStatError")<{
  readonly path: string
  readonly cause: unknown
}> {}

export class BootstrapRpcError extends Data.TaggedError("BootstrapRpcError")<{
  readonly operation: "list" | "create"
  readonly cause: unknown
}> {}

export const bootstrapProjects = Effect.fn("ClientExample.bootstrapProjects")(function*(root: string) {
  if (root.length === 0 || root.startsWith("--")) {
    return yield* new BootstrapInvalidInputError({ root })
  }
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const client = yield* ProjectClient
  const entries = yield* fs.readDirectory(root).pipe(
    Effect.mapError((cause) => new BootstrapReadError({ root, cause }))
  )
  const subdirs = yield* Effect.filter([...entries].sort(), (name) => {
    const entry = path.join(root, name)
    return fs.stat(entry).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.mapError((cause) => new BootstrapStatError({ path: entry, cause }))
    )
  })
  const existing = yield* client.list({ includeArchived: true }).pipe(
    Effect.mapError((cause) => new BootstrapRpcError({ operation: "list", cause }))
  )
  const known = new Set(existing.projects.map((project) => String(project.name)))
  let created = 0
  let skipped = 0
  for (const name of subdirs) {
    if (known.has(name)) {
      skipped++
      continue
    }
    const outcome = yield* client.create({ name, ensure: false, directory: path.join(root, name) }).pipe(
      Effect.map(() => "created" as const),
      Effect.catchTags({
        ProjectAlreadyExists: () => Effect.succeed("skipped" as const),
        ProjectDirectoryConflict: () => Effect.succeed("skipped" as const),
        ProjectDirectoryInvalid: () => Effect.succeed("skipped" as const),
        ProjectInvalidInput: () => Effect.succeed("skipped" as const),
        RpcClientError: (cause) => new BootstrapRpcError({ operation: "create", cause })
      })
    )
    if (outcome === "created") created++
    else skipped++
  }
  yield* Console.log(`bootstrap: created ${created}, skipped ${skipped}`)
})

export const bootstrapProjectsProgram = Effect.scoped(Effect.gen(function*() {
  const args = yield* (yield* Stdio.Stdio).args
  yield* bootstrapProjects(args[0] ?? "")
})).pipe(
  Effect.provide(clientLayer(adapter).pipe(Layer.provideMerge(NodeServices.layer)))
)

if (import.meta.main) {
  NodeRuntime["runMain"](bootstrapProjectsProgram)
}
