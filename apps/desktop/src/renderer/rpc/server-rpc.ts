import { Context, Effect, Layer } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import { RendererRpcClient } from "@expand/desktop/renderer/rpc/transport"

export interface ServerRpcApi {
  readonly health: () => Effect.Effect<string, RpcClientError.RpcClientError>
}

export class ServerRpc extends Context.Service<ServerRpc, ServerRpcApi>()(
  "expand/desktop/ServerRpc"
) {}

export const ServerRpcLayer: Layer.Layer<ServerRpc, never, RendererRpcClient> = Layer.effect(
  ServerRpc,
  Effect.map(RendererRpcClient, (client): ServerRpcApi => ({
    health: () => client.Health()
  }))
)
