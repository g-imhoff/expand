import { Context, Effect, Layer } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import type { Crypto, FileSystem, Path } from "effect"
import type { AppContext } from "@expand/contracts/app-context"
import type { ProcessControl } from "@expand/contracts/process-control"
import type { BackendUnavailable } from "../errors"
import type { RuntimeAdapter } from "../adapter"
import { ClientSession, ClientSessionLayer } from "../client-session"

export interface ServerClientApi {
  readonly health: () => Effect.Effect<string, RpcClientError.RpcClientError>
}

export class ServerClient extends Context.Service<ServerClient, ServerClientApi>()(
  "expand/ServerClient"
) {}

/** @internal */
export const ServerClientLive: Layer.Layer<ServerClient, never, ClientSession> = Layer.effect(
  ServerClient,
  Effect.map(ClientSession, (session): ServerClientApi => ({
    health: () => Effect.flatMap(session.current, (client) => client.Health())
  }))
)

export const ServerClientLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<
  ServerClient,
  BackendUnavailable,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | AppContext | ProcessControl
> =>
  ServerClientLive.pipe(Layer.provide(ClientSessionLayer(adapter)))
