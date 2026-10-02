import { Effect, FileSystem, Option, Schema } from "effect"
import { type Endpoint, EndpointFromJson } from "@expand/contracts/endpoint"
import { PROTOCOL_VERSION } from "@expand/contracts/rpc/version"
import { AppContext } from "@expand/contracts/app-context"
import { ProcessControl, type ProcessProbeError } from "@expand/contracts/process-control"
import { incarnationsMatch } from "@expand/contracts/process-incarnation"

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
    if (endpoint.incarnation === undefined) {
      if ((yield* processControl.probe(endpoint.pid)) === "dead") return Option.none()
      return Option.some(endpoint)
    }
    const observed = yield* processControl.identify(endpoint.pid)
    if (observed.status !== "alive") return Option.none()
    if (observed.identity === undefined) return Option.none()
    return incarnationsMatch(endpoint.incarnation, observed.identity)
      ? Option.some(endpoint)
      : Option.none()
  })
