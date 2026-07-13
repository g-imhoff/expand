import type { Effect, Layer } from "effect"
import type { RpcClient } from "effect/unstable/rpc"
import type { BackendUnavailable } from "./errors"

/**
 * Supplies the platform-specific operations required by the client runtime.
 *
 * @remarks
 * Implementations isolate RPC transport and backend process primitives from the
 * platform-independent client core. The built-in Node adapter satisfies this
 * contract.
 */
export interface RuntimeAdapter {
  /**
   * Builds the RPC protocol for an authenticated backend WebSocket endpoint.
   *
   * @param url - The backend WebSocket URL, including its authentication token.
   * @returns A layer providing the {@link RpcClient.Protocol} used by the client.
   */
  readonly protocolLayer: (url: string) => Layer.Layer<RpcClient.Protocol>
  /**
   * Starts a backend process for the requested data directory.
   *
   * @remarks
   * Completion means the process launch was accepted; endpoint discovery
   * separately confirms that the backend is ready to accept connections.
   *
   * @param dataDir - The data directory the backend must use.
   * @returns An effect that completes after launch or fails with {@link BackendUnavailable}.
   */
  readonly spawnBackend: (dataDir: string) => Effect.Effect<void, BackendUnavailable>
}
