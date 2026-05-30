import type { Effect, Layer } from "effect"
import type { RpcClient } from "effect/unstable/rpc"

// The ONLY cross-runtime seam. Each runtime (Bun, Node) supplies these as
// Effect values/layers; client-core (discovery, withClient, ProjectStore) is
// written once against this interface. Effect-first: protocolLayer is a Layer,
// spawnBackend is an Effect — no raw side effects leak through here.
export interface RuntimeAdapter {
  // A fully-satisfied RPC transport Layer for a known backend URL (NDJSON over
  // WebSocket). Bun: self-contained. Node: wraps the `ws` package.
  readonly protocolLayer: (url: string) => Layer.Layer<RpcClient.Protocol>
  // Launch `<backend> server` detached (process owns its own lifetime; we unref).
  readonly spawnBackend: Effect.Effect<void>
}
