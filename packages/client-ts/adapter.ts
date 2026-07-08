import type { Effect, Layer } from "effect"
import type { RpcClient } from "effect/unstable/rpc"
import type { BackendUnavailable } from "@expand/client-ts/discovery"

export interface RuntimeAdapter {
  readonly protocolLayer: (url: string) => Layer.Layer<RpcClient.Protocol>
  readonly spawnBackend: (dataDir: string) => Effect.Effect<void, BackendUnavailable>
}
