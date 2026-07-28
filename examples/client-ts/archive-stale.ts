import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Layer, Console, Data, Effect, FileSystem, Path, Schedule, Stdio } from "effect"
import { dataDirFromArgs } from "@expand/contracts/app-context"
import { ProjectClient } from "@expand/client-ts/project"
import { adapter } from "./adapter"
import { clientLayer } from "./client-layer"

export class ArchiveFileSystemError extends Data.TaggedError("ArchiveFileSystemError")<{
  readonly path: string
  readonly cause: unknown
}> {}

export class ArchiveInvalidInputError extends Data.TaggedError("ArchiveInvalidInputError")<{
  readonly id: string
}> {}

export class ArchiveRpcError extends Data.TaggedError("ArchiveRpcError")<{
  readonly operation: "list" | "archive"
  readonly cause: unknown
}> {}

export class ArchiveShutdownTimeoutError extends Data.TaggedError("ArchiveShutdownTimeoutError")<{
  readonly lockFile: string
}> {}

export const waitForBackendShutdown = Effect.fn("ClientExample.waitForBackendShutdown")(
  (lockFile: string, endpointFile?: string) => {
    const ShutdownPending = Data.TaggedError("ArchiveShutdownPending")
    const pending = FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => Effect.all([
        fs.exists(lockFile),
        endpointFile === undefined ? Effect.succeed(false) : fs.exists(endpointFile)
      ])),
      Effect.mapError((cause) => new ArchiveFileSystemError({ path: lockFile, cause })),
      Effect.flatMap(([locked, advertised]) =>
        !locked || advertised ? Effect.void : Effect.fail(new ShutdownPending(undefined)))
    )
    return pending.pipe(
      Effect.retry(Schedule.addDelay(Schedule.recurs(100), () => Effect.succeed("50 millis"))),
      Effect.catchTag("ArchiveShutdownPending", () =>
        new ArchiveShutdownTimeoutError({ lockFile }))
    )
  }
)

export const archiveMissingProjects = Effect.fn("ClientExample.archiveMissingProjects")(function*() {
  const fs = yield* FileSystem.FileSystem
  const client = yield* ProjectClient
  const { projects } = yield* client.list({ includeArchived: false }).pipe(
    Effect.mapError((cause) => new ArchiveRpcError({ operation: "list", cause }))
  )
  let archived = 0
  for (const project of projects) {
    if (String(project.id).length === 0) {
      return yield* new ArchiveInvalidInputError({ id: String(project.id) })
    }
    if (project.directory !== null) {
      const exists = yield* fs.exists(project.directory).pipe(
        Effect.mapError((cause) => new ArchiveFileSystemError({ path: project.directory as string, cause }))
      )
      if (!exists) {
        yield* client.archive({ id: String(project.id) }).pipe(
          Effect.mapError((cause) => new ArchiveRpcError({ operation: "archive", cause }))
        )
        archived++
        yield* Console.log(`  archived ${String(project.name)} (missing dir: ${project.directory})`)
      }
    }
  }
  yield* Console.log(`archive-stale: archived ${archived} of ${projects.length} active`)
})

export const archiveStale = archiveMissingProjects()

export const archiveStaleProgram = Effect.scoped(Effect.gen(function*() {
  const args = yield* (yield* Stdio.Stdio).args
  const dataDir = dataDirFromArgs(args)
  if (dataDir !== undefined) {
    const path = yield* Path.Path
    yield* waitForBackendShutdown(path.join(dataDir, "backend.lock"), path.join(dataDir, "server.json"))
  }
  yield* archiveMissingProjects()
})).pipe(
  Effect.provide(clientLayer(adapter).pipe(Layer.provideMerge(NodeServices.layer)))
)

if (import.meta.main) {
  NodeRuntime["runMain"](archiveStaleProgram)
}
