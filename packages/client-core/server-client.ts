import { Context, Effect, Layer } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import type { FileSystem } from "effect"
import type { BackendUnavailable } from "@expand/client-core/discovery"
import type { RuntimeAdapter } from "@expand/client-core/adapter"
import { ExpandRpcClient, ExpandRpcClientLive } from "@expand/client-core/rpc-client"

export interface ServerClientApi {
  readonly health: () => Effect.Effect<string, RpcClientError.RpcClientError>
}

export class ServerClient extends Context.Service<ServerClient, ServerClientApi>()(
  "expand/ServerClient"
) {}

export const ServerClientLive: Layer.Layer<ServerClient, never, ExpandRpcClient> = Layer.effect(
  ServerClient,
  Effect.map(ExpandRpcClient, (client): ServerClientApi => ({
    health: () => client.Health()
  }))
)

export const ServerClientLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ServerClient, BackendUnavailable, FileSystem.FileSystem> =>
  ServerClientLive.pipe(Layer.provide(ExpandRpcClientLive(adapter)))
