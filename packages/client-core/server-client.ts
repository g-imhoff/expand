import { Context, Effect, Layer } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import type { FileSystem } from "effect"
import type { AppContext } from "@yodea/contracts/app-context"
import type { BackendUnavailable } from "@yodea/client-core/discovery"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"
import { YodeaRpcClient, YodeaRpcClientLive } from "@yodea/client-core/rpc-client"

export interface ServerClientApi {
  readonly health: () => Effect.Effect<string, RpcClientError.RpcClientError>
}

export class ServerClient extends Context.Service<ServerClient, ServerClientApi>()(
  "yodea/ServerClient"
) {}

export const ServerClientLive: Layer.Layer<ServerClient, never, YodeaRpcClient> = Layer.effect(
  ServerClient,
  Effect.map(YodeaRpcClient, (client): ServerClientApi => ({
    health: () => client.Health()
  }))
)

export const ServerClientLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ServerClient, BackendUnavailable, FileSystem.FileSystem | AppContext> =>
  ServerClientLive.pipe(Layer.provide(YodeaRpcClientLive(adapter)))
