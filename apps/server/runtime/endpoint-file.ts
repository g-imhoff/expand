import { Cause, Effect, Exit, FileSystem, Path, PlatformError, Schema } from "effect"
import type { Endpoint } from "@expand/contracts/endpoint"
import { EndpointFromJson } from "@expand/contracts/endpoint"
import { AppContext } from "@expand/contracts/app-context"

export const writeEndpointFile = Effect.fn("EndpointFile.write")((endpoint: Endpoint) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { paths } = yield* AppContext
      yield* fs.makeDirectory(path.dirname(paths.endpointFile), { recursive: true, mode: 0o700 })
      const json = yield* Schema.encodeEffect(EndpointFromJson)(endpoint)
      yield* fs.writeFileString(paths.endpointFile, json, { mode: 0o600 })
      yield* fs.chmod(paths.endpointFile, 0o600)
      return paths.endpointFile
    }),
    (file, ownerExit) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => releaseEndpointFile(fs, file, ownerExit))
      )
  )
)

export const removeEndpointFile = Effect.fn("EndpointFile.remove")((
  fs: FileSystem.FileSystem,
  file: string
) => fs.remove(file).pipe(
  Effect.catchIf(
    (error) => error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound",
    () => Effect.void
  )
))

const releaseEndpointFile = Effect.fn("EndpointFile.release")(function* (
  fs: FileSystem.FileSystem,
  file: string,
  ownerExit: Exit.Exit<unknown, unknown>
) {
  const cleanup = yield* removeEndpointFile(fs, file).pipe(Effect.orDie, Effect.exit)
  if (Exit.isSuccess(cleanup)) return
  const cause = Exit.isFailure(ownerExit)
    ? Cause.combine(ownerExit.cause, cleanup.cause)
    : cleanup.cause
  return yield* Effect.failCause(cause) as Effect.Effect<never, never>
})
