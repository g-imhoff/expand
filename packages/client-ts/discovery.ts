import { Effect, FileSystem, Option, Schema } from "effect"
import { type Endpoint, EndpointFromJson, PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { AppContext } from "@expand/contracts/app-context"

export const readEndpoint: Effect.Effect<Option.Option<Endpoint>, never, FileSystem.FileSystem> =
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const { paths } = yield* AppContext
    if (!(yield* fs.exists(paths.endpointFile).pipe(Effect.orElseSucceed(() => false)))) {
      return Option.none()
    }
    const text = yield* fs.readFileString(paths.endpointFile).pipe(Effect.orElseSucceed(() => ""))
    const decoded = yield* Schema.decodeUnknownEffect(EndpointFromJson)(text).pipe(Effect.option)
    if (Option.isNone(decoded)) return Option.none()
    const endpoint = decoded.value
    if (endpoint.protocolVersion !== PROTOCOL_VERSION) return Option.none()
    if (!isProcessAlive(endpoint.pid)) return Option.none()
    return Option.some(endpoint)
  })

/** @internal */
export const deleteEndpoint: Effect.Effect<void, never, FileSystem.FileSystem> =
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const { paths } = yield* AppContext
    yield* fs.remove(paths.endpointFile).pipe(Effect.ignore)
  })

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
