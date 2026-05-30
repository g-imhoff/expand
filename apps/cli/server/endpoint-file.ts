import { Effect, FileSystem, Path, Schema } from "effect"
import type { Endpoint } from "@yodea/contracts/endpoint"
import { EndpointFromJson, endpointFilePath } from "@yodea/contracts/endpoint"

// I-3: write server.json on acquire, remove it on scope close (clean shutdown).
export const writeEndpointFile = (endpoint: Endpoint) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = endpointFilePath()
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      const json = yield* Schema.encodeEffect(EndpointFromJson)(endpoint)
      yield* fs.writeFileString(file, json)
      return file
    }),
    (file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.remove(file)
      }).pipe(Effect.ignore) // cleanup is best-effort; the file may already be gone
  )
