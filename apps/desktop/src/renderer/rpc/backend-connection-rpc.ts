import { Context, Effect, Layer } from "effect"
import type { BackendConnectionPayload } from "@expand/contracts/rpc/backend-connection"
import { RendererRpcClient } from "@expand/desktop/renderer/rpc/transport"

export class BackendConnectionRpc extends Context.Service<BackendConnectionRpc, {
  readonly get: () => Effect.Effect<BackendConnectionPayload, unknown, never>
  readonly set: (
    connection: BackendConnectionPayload
  ) => Effect.Effect<BackendConnectionPayload, unknown, never>
  readonly test: (
    connection: BackendConnectionPayload
  ) => Effect.Effect<{ readonly reachable: boolean; readonly authorized: boolean }, unknown, never>
}>()("expand/desktop/BackendConnectionRpc") {}

export const BackendConnectionRpcLayer: Layer.Layer<BackendConnectionRpc, never, RendererRpcClient> =
  Layer.effect(
    BackendConnectionRpc,
    Effect.map(RendererRpcClient, (client) => ({
      get: () => client.BackendConnectionGet(),
      set: (connection: BackendConnectionPayload) => client.BackendConnectionSet(connection),
      test: (connection: BackendConnectionPayload) => client.BackendConnectionTest(connection)
    }))
  )
