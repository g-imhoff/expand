import { Data, Effect, FileSystem, Option, Schema } from "effect"
import { type Endpoint, EndpointFromJson, endpointFilePath, PROTOCOL_VERSION } from "@yodea/shared/endpoint"

export class BackendUnavailable extends Data.TaggedError("BackendUnavailable")<{
  readonly reason: string
}> {}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0) // signal 0 = liveness probe, doesn't actually signal
    return true
  } catch {
    return false
  }
}

// Read + validate the discovery file. None if missing, malformed, wrong
// protocol, or owned by a dead pid (stale).
export const readEndpoint: Effect.Effect<Option.Option<Endpoint>, never, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = endpointFilePath()
    if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
      return Option.none()
    }
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
    const decoded = yield* Schema.decodeUnknownEffect(EndpointFromJson)(text).pipe(Effect.option)
    if (Option.isNone(decoded)) return Option.none()
    const endpoint = decoded.value
    if (endpoint.protocolVersion !== PROTOCOL_VERSION) return Option.none()
    if (!isProcessAlive(endpoint.pid)) return Option.none()
    return Option.some(endpoint)
  })
