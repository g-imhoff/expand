import { Effect, FileSystem, Option, PlatformError, Schema } from "effect"
import { type Endpoint, EndpointFromJson } from "@expand/contracts/endpoint"
import { PROTOCOL_VERSION } from "@expand/contracts/rpc/version"
import { AppContext } from "@expand/contracts/app-context"
import { ProcessControl, type ProcessProbeError } from "@expand/contracts/process-control"
import { EndpointDiscoveryError } from "./errors"

export const readEndpoint: Effect.Effect<
  Option.Option<Endpoint>,
  ProcessProbeError | EndpointDiscoveryError,
  FileSystem.FileSystem | AppContext | ProcessControl
> =
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const { paths } = yield* AppContext
    const processControl = yield* ProcessControl
    const present = yield* fs.exists(paths.endpointFile).pipe(
      Effect.mapError((cause) => discoveryError("exists", paths.endpointFile, cause))
    )
    if (!present) {
      return Option.none()
    }
    const text = yield* fs.readFileString(paths.endpointFile).pipe(
      Effect.catchIf(
        (cause) => hasSystemReason(cause, "NotFound"),
        () => Effect.void
      ),
      Effect.mapError((cause) => discoveryError("readFileString", paths.endpointFile, cause))
    )
    if (text === undefined) return Option.none()
    const decoded = yield* Schema.decodeUnknownEffect(EndpointFromJson)(text).pipe(Effect.option)
    if (Option.isNone(decoded)) return Option.none()
    const endpoint = decoded.value
    if (endpoint.protocolVersion !== PROTOCOL_VERSION) return Option.none()
    if ((yield* processControl.probe(endpoint.pid)) === "dead") return Option.none()
    return Option.some(endpoint)
  })

const hasSystemReason = (
  cause: PlatformError.PlatformError,
  reason: PlatformError.SystemErrorTag
): boolean => cause.reason._tag === reason

const discoveryError = (
  operation: string,
  path: string,
  cause: unknown
) => new EndpointDiscoveryError({ operation, path, cause })
