import { Effect, FileSystem, Option, Schema } from "effect"
import { type Endpoint, EndpointFromJson, PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { AppContext } from "@expand/contracts/app-context"
import { ProcessControl, type ProcessProbeError } from "@expand/contracts/process-control"

export const readEndpoint: Effect.Effect<
  Option.Option<Endpoint>,
  ProcessProbeError,
  FileSystem.FileSystem | AppContext | ProcessControl
> =
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const { paths } = yield* AppContext
    const processControl = yield* ProcessControl
    if (!(yield* fs.exists(paths.endpointFile).pipe(Effect.orElseSucceed(() => false)))) {
      return Option.none()
    }
    const text = yield* fs.readFileString(paths.endpointFile).pipe(Effect.orElseSucceed(() => ""))
    const decoded = yield* Schema.decodeUnknownEffect(EndpointFromJson)(text).pipe(Effect.option)
    if (Option.isNone(decoded)) return Option.none()
    const endpoint = decoded.value
    if (endpoint.protocolVersion !== PROTOCOL_VERSION) return Option.none()
    if ((yield* processControl.probe(endpoint.pid)) === "dead") return Option.none()
    return Option.some(endpoint)
  })

export const deleteEndpoint: Effect.Effect<void, never, FileSystem.FileSystem | AppContext> =
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const { paths } = yield* AppContext
    yield* fs.remove(paths.endpointFile).pipe(Effect.ignore)
  })
