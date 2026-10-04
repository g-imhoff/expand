import { Effect, Exit, FileSystem, Layer, Path, Schema } from "effect"
import { RpcClient } from "effect/rpc"
import { HttpClient } from "effect/http"
import { NodeHttpClient } from "@effect/platform-node"
import { ExpandRpcs } from "@expand/contracts/rpc"
import type { Endpoint } from "@expand/contracts/endpoint"
import { PROTOCOL_VERSION } from "@expand/contracts/rpc/version"
import { AppContext } from "@expand/contracts/app-context"
import type {
  BackendConnection,
  BackendConnectionTestResult,
  RemoteConnection
} from "@expand/contracts/backend-connection"
import {
  BackendConnectionFromJson,
  BackendConnectionInvalid,
  normalizeRemoteUrl
} from "@expand/contracts/backend-connection"
import { BackendUnavailable } from "./errors"
import type { RuntimeAdapter } from "./adapter"

export type { BackendConnection, BackendConnectionTestResult, RemoteConnection }
export { BackendConnectionInvalid }
export const resolveRemoteEndpoint = (connection: RemoteConnection): Endpoint => ({
  url: normalizeRemoteUrl(connection.url),
  token: connection.token,
  pid: 0,
  protocolVersion: PROTOCOL_VERSION
})
export const remoteConnectionFile: Effect.Effect<string, never, Path.Path | AppContext> =
  Effect.gen(function*() {
    const path = yield* Path.Path
    const { paths } = yield* AppContext
    return path.join(path.dirname(paths.endpointFile), "remote-backend.json")
  })
export const readRemoteConnection: Effect.Effect<
  BackendConnection,
  BackendUnavailable,
  FileSystem.FileSystem | Path.Path | AppContext
> = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const file = yield* remoteConnectionFile
  const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false as const))
  if (!exists) return { _tag: "local" } as BackendConnection
  const text = yield* fs.readFileString(file).pipe(
    Effect.mapError((cause) => new BackendUnavailable({ reason: "remote connection read failed", cause }))
  )
  return yield* Schema.decodeUnknownEffect(BackendConnectionFromJson)(text).pipe(
    Effect.mapError((cause) => new BackendUnavailable({ reason: "remote connection corrupt", cause }))
  )
})
export const writeRemoteConnection = (
  connection: BackendConnection
): Effect.Effect<
  BackendConnection,
  BackendUnavailable | BackendConnectionInvalid,
  FileSystem.FileSystem | Path.Path | AppContext
> =>
  Effect.gen(function*() {
    yield* validateConnection(connection)
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = yield* remoteConnectionFile
    yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.mapError((cause) => new BackendUnavailable({ reason: "remote connection write failed", cause }))
    )
    const json = yield* Schema.encodeEffect(BackendConnectionFromJson)(connection).pipe(
      Effect.mapError((cause) => new BackendUnavailable({ reason: "remote connection encode failed", cause }))
    )
    yield* Effect.scoped(Effect.gen(function*() {
      const directory = yield* fs.makeTempDirectoryScoped({ directory: path.dirname(file), prefix: ".remote-" }).pipe(
        Effect.mapError((cause) => new BackendUnavailable({ reason: "remote connection write failed", cause }))
      )
      const temporary = path.join(directory, path.basename(file))
      yield* fs.writeFileString(temporary, json).pipe(
        Effect.mapError((cause) => new BackendUnavailable({ reason: "remote connection write failed", cause }))
      )
      yield* fs.chmod(temporary, 0o600).pipe(
        Effect.mapError((cause) => new BackendUnavailable({ reason: "remote connection write failed", cause }))
      )
      yield* fs.rename(temporary, file).pipe(
        Effect.mapError((cause) => new BackendUnavailable({ reason: "remote connection write failed", cause }))
      )
    }))
    yield* fs.chmod(file, 0o600).pipe(
      Effect.mapError((cause) => new BackendUnavailable({ reason: "remote connection write failed", cause }))
    )
    return connection
  })
export const validateConnection = (
  connection: BackendConnection
): Effect.Effect<void, BackendConnectionInvalid> => {
  if (connection._tag === "local") return Effect.void
  if (connection.url.trim().length === 0) {
    return Effect.fail(new BackendConnectionInvalid({ field: "url", reason: "url is required" }))
  }
  if (connection.token.trim().length === 0) {
    return Effect.fail(new BackendConnectionInvalid({ field: "token", reason: "token is required" }))
  }
  return Effect.try({
    try: () => normalizeRemoteUrl(connection.url),
    catch: () => new BackendConnectionInvalid({ field: "url", reason: "url is invalid" })
  }).pipe(Effect.asVoid)
}
export const testRemoteConnection = (
  adapter: Pick<RuntimeAdapter, "protocolLayer">,
  connection: BackendConnection
): Effect.Effect<BackendConnectionTestResult, BackendConnectionInvalid> =>
  Effect.gen(function*() {
    yield* validateConnection(connection)
    if (connection._tag === "local") return { reachable: true, authorized: true }
    const endpoint = resolveRemoteEndpoint(connection)
    const toHttpUrl = (wsUrl: string): string | undefined => {
      try {
        const parsed = new URL(wsUrl)
        parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:"
        parsed.search = ""
        return parsed.toString()
      } catch {
        return undefined
      }
    }
    const probeReachable: Effect.Effect<boolean> = Effect.gen(function*() {
      const httpUrl = toHttpUrl(endpoint.url)
      if (httpUrl === undefined) return false
      const client = yield* HttpClient.HttpClient
      const result = yield* client.get(httpUrl).pipe(Effect.timeout("2 seconds"), Effect.exit)
      return Exit.isSuccess(result)
    }).pipe(
      Effect.provide(NodeHttpClient.layerFetch),
      Effect.orElseSucceed(() => false)
    )
    const probeAuthorized: Effect.Effect<boolean> = Effect.scoped(Effect.gen(function*() {
      const withToken = `${endpoint.url}?token=${encodeURIComponent(endpoint.token)}`
      const protocol = yield* Layer.build(adapter.protocolLayer(withToken)).pipe(Effect.option)
      if (protocol._tag === "None") return false
      return yield* RpcClient.make(ExpandRpcs).pipe(
        Effect.provideContext(protocol.value),
        Effect.flatMap((client) => client.Health()),
        Effect.timeout("3 seconds"),
        Effect.match({ onFailure: () => false, onSuccess: () => true })
      )
    }).pipe(Effect.orElseSucceed(() => false)))
    const reachable = yield* probeReachable
    if (!reachable) return { reachable: false, authorized: false }
    const authorized = yield* probeAuthorized
    return { reachable: true, authorized }
  })
export const remoteSpawnGuard = (): BackendUnavailable =>
  new BackendUnavailable({ reason: "remote backend unavailable: refusing to spawn a local replacement" })
