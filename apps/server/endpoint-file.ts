import { Effect, FileSystem, Path, Schema } from "effect"
import type { Endpoint } from "@expand/contracts/endpoint"
import { EndpointFromJson } from "@expand/contracts/endpoint"
import { AppContext } from "@expand/contracts/app-context"

export const writeEndpointFile = (endpoint: Endpoint) =>
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
    (file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.remove(file)
      }).pipe(Effect.ignore)
  )
