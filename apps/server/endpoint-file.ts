import { Effect, FileSystem, Path, Schema } from "effect"
import type { Endpoint } from "@yodea/contracts/endpoint"
import { EndpointFromJson, endpointFilePath } from "@yodea/contracts/endpoint"

export const writeEndpointFile = (endpoint: Endpoint) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = endpointFilePath()
      yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 })
      const json = yield* Schema.encodeEffect(EndpointFromJson)(endpoint)
      yield* fs.writeFileString(file, json, { mode: 0o600 })
      yield* fs.chmod(file, 0o600)
      return file
    }),
    (file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.remove(file)
      }).pipe(Effect.ignore)
  )
