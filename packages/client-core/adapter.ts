import type { Effect, Layer } from "effect"
import type { RpcClient } from "effect/unstable/rpc"

export interface RuntimeAdapter {
  readonly protocolLayer: (url: string) => Layer.Layer<RpcClient.Protocol>
  readonly spawnBackend: Effect.Effect<void>
}
